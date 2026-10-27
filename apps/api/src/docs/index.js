// apps/api/src/docs/index.js
// Serves the hand-maintained OpenAPI spec (openapi.yaml) through Swagger UI.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import swaggerUi from 'swagger-ui-express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const spec = YAML.parse(fs.readFileSync(path.join(__dirname, 'openapi.yaml'), 'utf8'));
export const serveDocs = swaggerUi.serve;
export const setupDocs = swaggerUi.setup(spec);
