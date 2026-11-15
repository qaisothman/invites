import 'dotenv/config';
import { DataSource } from 'typeorm';
import { typeOrmOptions } from './typeorm.options';

// Entry point for the TypeORM CLI (npm run migration:generate / migration:run).
// The app itself never imports this file.
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

// Migrations are not requests: an index build may run for minutes, so the
// API's statement timeout is lifted here.
export default new DataSource(typeOrmOptions(url, 2, 0));
