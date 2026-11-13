import 'dotenv/config';
import { DataSource } from 'typeorm';
import { typeOrmOptions } from './typeorm.options';

// Entry point for the TypeORM CLI (npm run migration:generate / migration:run).
// The app itself never imports this file.
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

export default new DataSource(typeOrmOptions(url));
