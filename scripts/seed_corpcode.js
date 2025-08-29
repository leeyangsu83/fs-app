// Seed PostgreSQL with corp codes parsed from CORPCODE.xml
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const XML_PATH = path.join(__dirname, '..', 'data', 'corpcode', 'CORPCODE.xml');

async function parseXml(filePath) {
  const xml = fs.readFileSync(filePath, 'utf8');
  const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true, trim: true });
  const result = await parser.parseStringPromise(xml);
  const listNodes = result?.result?.list || [];
  const items = Array.isArray(listNodes) ? listNodes : [listNodes];
  return items.map((c) => ({
    corp_code: c.corp_code?.trim?.() || '',
    corp_name: c.corp_name?.trim?.() || '',
    corp_eng_name: c.corp_eng_name?.trim?.() || '',
    stock_code: (c.stock_code || '').trim(),
    modify_date: c.modify_date?.trim?.() || '',
  })).filter((c) => c.corp_code);
}

async function main() {
  if (!fs.existsSync(XML_PATH)) {
    console.error('XML not found:', XML_PATH);
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL environment variable not set. Please check your .env file.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log('Connected to PostgreSQL. Setting up table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS corps (
        corp_code VARCHAR(8) PRIMARY KEY,
        corp_name VARCHAR(255) NOT NULL,
        corp_eng_name VARCHAR(255),
        stock_code VARCHAR(6),
        modify_date VARCHAR(8)
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_corp_name ON corps (corp_name);');
    console.log('Table "corps" is ready.');

    await client.query('TRUNCATE TABLE corps;');
    console.log('Existing data cleared.');

    const docs = await parseXml(XML_PATH);
    if (docs.length === 0) {
      console.error('Parsed 0 corp entries. Check XML structure.');
      process.exit(1);
    }

    // Use pg-format or a loop for robust insertion
    console.log(`Inserting ${docs.length} entries...`);
    for (const doc of docs) {
      await client.query(
        'INSERT INTO corps (corp_code, corp_name, corp_eng_name, stock_code, modify_date) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (corp_code) DO NOTHING',
        [doc.corp_code, doc.corp_name, doc.corp_eng_name, doc.stock_code, doc.modify_date]
      );
    }
    
    console.log(`Seeded ${docs.length} corps to PostgreSQL.`);
  } finally {
    await client.release();
    await pool.end();
    console.log('Connection closed.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


