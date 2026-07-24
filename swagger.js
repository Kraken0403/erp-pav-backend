const swaggerAutogen = require('swagger-autogen')({ openapi: '3.0.0' });

const outputFile = './swagger_output.json';
const endpointsFiles = ['./server.js'];

const doc = {
  info: {
    title: 'ZOANS CRM API',
    description: 'Auto-generated API documentation for ZOANS CRM',
  },
  servers: [
    { url: 'https://api.jdhcaterers.com', description: 'Primary API (production)' },
    { url: 'http://localhost:5000', description: 'Local server' }
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT'
      }
    }
  },
  security: [{ bearerAuth: [] }],
};

swaggerAutogen(outputFile, endpointsFiles, doc).then(() => {
  console.log('Swagger output generated to', outputFile);
  // After generation, start the server so /api-docs is available
  require('./server.js');
});
