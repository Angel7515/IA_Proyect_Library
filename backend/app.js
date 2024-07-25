const express = require('express');
const bodyParser = require('body-parser');
const OpenAI = require('openai');
const cors = require('cors');
const fs = require('fs');
const csv = require('csv-parser');
const XLSX = require('xlsx');
const path = require('path');
const multer = require('multer');
const { EventEmitter } = require('events');
const session = require('express-session');

// Cargar variables de entorno desde el archivo .env
require('dotenv').config();

const app = express();
const port = 3000;

// Configuración para obtener la API KEY de OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(bodyParser.json());

app.use(session({
  secret: 'your-secret-key', // Reemplaza con una clave secreta segura
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Usa secure: true si usas HTTPS
}));

const upload = multer({
  dest: 'uploads/',
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv') {
      cb(null, true);
    } else {
      cb(new Error('El archivo debe ser un CSV'), false);
    }
  }
});

// Instrucciones específicas para el asistente
const systemInstructions = {
  role: "system",
  content: `
  You are an expert assistant specialized in APA 7 citation format for presentations in English. 
  When formatting citations, always follow these rules:
  1. If the location is not provided, use "CIMMYT" as the default location.
  2. Ensure all elements of the citation are correctly formatted according to APA 7 guidelines.
  3. Format the response with each citation on a new line, prefixed with a bullet point or a numeral.
  4. When the data is sent to you, just reply: "The citations for the data submitted are as follows:" and send the formatted citations.
  `
};

// Función para limpiar los datos de la columna dc.creator
function cleanCreatorData(data) {
  return data.split('||').map(author => author.split('::')[0]).join(', ');
}

// Función para limpiar los datos de la columna dc.date.issued
function cleanDateData(data) {
  const datePattern = /\b(19|20)\d{2}\b/; // Acepta solo años de 1900 a 2099
  const match = data.match(datePattern);
  return match ? match[0] : data;
}

// Función para formatear los datos para enviar a la API
function formatDataForAPI(row) {
  return `
    Author (s): ${row['dc.creator']}
    Conference Name: ${row['dc.conference.name']}
    Conference Place: ${row['dc.conference.place']}
    Date: ${row['dc.date.issued']}
    URI: ${row['dc.identifier.uri']}
    Title: ${row['dc.title']}
    Type: ${row['dc.type']}
  `;
}

// Ruta para manejar las solicitudes de conversación
app.post('/api/conversation', async (req, res) => {
  const { messages } = req.body;

  // Añadir las instrucciones del sistema solo la primera vez que se interactúa
  if (!req.session.instructionsAdded) {
    req.session.instructionsAdded = true;
    req.session.messages = [systemInstructions, ...messages];
  } else {
    req.session.messages = [...req.session.messages, ...messages];
  }

  try {
    // Enviar la solicitud a la API de OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: req.session.messages,
    });

    // Almacenar la conversación en la sesión
    req.session.messages.push({
      role: 'assistant',
      content: completion.choices[0].message.content
    });

    // Devolver la respuesta al cliente
    res.send({ response: completion.choices[0].message.content });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error interno del servidor');
  }
});

// Ruta para manejar la generación del archivo Excel y la integración con OpenAI
app.post('/api/generate-excel', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('No se ha subido ningún archivo o el archivo no es un CSV');
  }

  const inputFile = req.file.path; // Ruta al archivo CSV subido
  const outputFile = path.join(__dirname, 'DataFiles', 'citations_data.xlsx'); // Ruta al archivo Excel resultante

  const columnsToKeep = [
    'dc.conference.name[]', 'dc.conference.name[en_US]',
    'dc.conference.place[]', 'dc.conference.place[en_US]',
    'dc.creator', 'dc.creator.aux', 'dc.creator.aux[]',
    'dc.creator.aux[en_US]', 'dc.creator.aux[eng]', 'dc.creator.corporate[]',
    'dc.date.issued', 'dc.date.issued[]', 'dc.date.issued[en_US]',
    'dc.date.issued[eng]', 'dc.identifier.uri', 'dc.identifier.uri[]',
    'dc.title', 'dc.title.alternative[]', 'dc.title[]', 'dc.title[en_US]',
    'dc.type', 'dc.type[]', 'dc.type[en_US]'
  ];

  const results = [];
  const eventEmitter = new EventEmitter();

  fs.createReadStream(inputFile)
    .pipe(csv())
    .on('data', (data) => {
      const filteredData = {};

      const conferenceName = data['dc.conference.name[]'] || data['dc.conference.name[en_US]'];
      const conferencePlace = data['dc.conference.place[]'] || data['dc.conference.place[en_US]'] || 'CIMMYT';
      const creator = data['dc.creator'] || data['dc.creator.aux'] || data['dc.creator.aux[]'] || data['dc.creator.aux[en_US]'] || data['dc.creator.aux[eng]'] || data['dc.creator.corporate[]'] || 'unknown';
      const dateIssued = data['dc.date.issued'] || data['dc.date.issued[]'] || data['dc.date.issued[en_US]'] || data['dc.date.issued[eng]'];
      const identifierUri = data['dc.identifier.uri'] || data['dc.identifier.uri[]'];
      const title = data['dc.title'] || data['dc.title.alternative[]'] || data['dc.title[]'] || data['dc.title[en_US]'];
      const type = data['dc.type'] || data['dc.type[]'] || data['dc.type[en_US]'];

      filteredData['dc.conference.name'] = conferenceName;
      filteredData['dc.conference.place'] = conferencePlace;
      filteredData['dc.creator'] = cleanCreatorData(creator);
      filteredData['dc.date.issued'] = cleanDateData(dateIssued);
      filteredData['dc.identifier.uri'] = identifierUri;
      filteredData['dc.title'] = title;
      filteredData['dc.type'] = type;

      results.push(filteredData);
    })
    .on('end', async () => {
      const totalRecords = results.length;
      let processedRecords = 0;

      const citations = [];

      for (const row of results) {
        const formattedData = formatDataForAPI(row);
        console.log('Datos enviados a la API:', formattedData);

        const messages = [
          { role: 'user', content: formattedData }
        ];

        try {
          const completion = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [systemInstructions, ...messages],
          });

          const citation = completion.choices[0].message.content;
          console.log('Citación recibida de la API:', citation);
          row['citation'] = citation;
          citations.push(row);
        } catch (error) {
          console.error('Error al obtener la citación de la API:', error);
          row['citation'] = 'Error al obtener la citación';
          citations.push(row);
        }

        processedRecords += 1;
        const progress = Math.floor((processedRecords / totalRecords) * 100);
        eventEmitter.emit('progress', { progress, processedRecords, totalRecords });
      }

      const worksheet = XLSX.utils.json_to_sheet(citations);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Citations Data');
      XLSX.writeFile(workbook, outputFile);

      res.sendFile(outputFile, (err) => {
        if (err) {
          console.error('Error sending Excel file:', err);
          res.status(500).send('Error sending Excel file');
        } else {
          fs.unlinkSync(inputFile); // Delete the temporary uploaded CSV file
          fs.unlinkSync(outputFile); // Optionally delete the generated Excel file after sending
        }
      });
    });

  app.get('/api/progress', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const progressListener = (progressData) => {
      res.write(`data: ${JSON.stringify(progressData)}\n\n`);
    };

    eventEmitter.on('progress', progressListener);

    req.on('close', () => {
      eventEmitter.removeListener('progress', progressListener);
    });
  });
});

app.listen(port, () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
});
