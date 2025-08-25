// Seed NeDB with corp codes parsed from CORPCODE.xml
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const Datastore = require('nedb-promises');

const XML_PATH = path.join(__dirname, '..', 'data', 'corpcode', 'CORPCODE.xml');
const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'corpCodes.db');

async function parseXml(filePath) {
  const xml = fs.readFileSync(filePath, 'utf8');
  const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true, trim: true });
  const result = await parser.parseStringPromise(xml);
  // Actual structure: <result><list><corp_code/>...</list><list>...</list>...</result>
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
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  const db = Datastore.create({ filename: DB_PATH, autoload: true });
  await db.remove({}, { multi: true });
  const docs = await parseXml(XML_PATH);
  if (docs.length === 0) {
    console.error('Parsed 0 corp entries. Check XML structure.');
    process.exit(1);
  }
  // Index for search
  db.ensureIndex({ fieldName: 'corp_name' });
  db.ensureIndex({ fieldName: 'corp_code', unique: true });
  await db.insert(docs);
  console.log(`Seeded ${docs.length} corps to`, DB_PATH);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


