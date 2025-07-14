const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const filePath = path.join(__dirname, 'your-key-file.json');
let keys;

try {
  const raw = fs.readFileSync(filePath, 'utf8');
  keys = JSON.parse(raw);
  console.log('🔐 Credentials loaded');
} catch (err) {
  console.error('❌ Failed to load credentials:', err.message);
  process.exit(1);
}

(async () => {
  const auth = new google.auth.JWT(
    keys.client_email,
    null,
    keys.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await auth.authorize();
  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheetId = '1CypDOy2PseT9FPz9cyz1JdFhsUmyfnrMGKSmJ2V0fe0';
  const sheetName = 'InHunt';

  const rowCount = (await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A2:A`,
  })).data.values?.length || 0;

  const [urlRes, timeRes, alertRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!X2:X${rowCount + 1}` }),
    sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!Y2:Y${rowCount + 1}` }),
    sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!AA2:AA${rowCount + 1}` }),
  ]);

  const urls = urlRes.data.values || [];
  const timestamps = timeRes.data.values || [];
  const alerts = alertRes.data.values || [];

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const updates = [];

  for (let i = 0; i < urls.length; i++) {
    const rowIndex = i + 2;
    const url = urls[i]?.[0] || '';
    const timestamp = timestamps[i]?.[0] || '';
    const alertFlag = alerts[i]?.[0] || '';

    if (!url.trim()) continue;
    if (new Date(timestamp) < new Date()) continue;
    if (alertFlag.trim()) continue;

    const page = await browser.newPage();
    let pageClosed = false;

    try {
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114 Safari/537.36'
      );

      page.on('dialog', async dialog => {
        await dialog.accept();
      });

      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);

      const html = await page.content();
      if (html.includes('"status":"invalid"')) {
        await page.close();
        pageClosed = true;
        continue;
      }

      const okButtons = await page.$x("//button[contains(., 'OK') or contains(., 'Accept')]");
      if (okButtons.length) {
        await okButtons[0].click();
        await page.waitForTimeout(1000);
      }

      // 🎯 Extract primary bid value
      let finalText = await page.evaluate(() => {
        const label = Array.from(document.querySelectorAll('ul.bid-info li b'))
          .find(el => el.textContent.includes('Current Bid'));
        const span = label?.parentElement?.querySelector('span[data-currency]');
        return span?.textContent.trim() || '';
      });

      // 🧮 Fallback extraction
      if (!finalText) {
        finalText = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('body *'))
            .filter(el => el.textContent && /\d+/.test(el.textContent))
            .map(el => el.textContent.trim())
            .find(t => t.length < 100) || '';
        });
      }

      // 🔢 Strip dollar sign and convert to number
      const numericBid = parseFloat(finalText.replace(/[^0-9.]/g, '')) || 'Unavailable';

      updates.push({
        range: `${sheetName}!Z${rowIndex}`,
        values: [[numericBid]],
      });

      if (numericBid === 'Unavailable') {
        const htmlSnap = await page.content();
        fs.writeFileSync(`failed-row-${rowIndex}.html`, htmlSnap);
      }

    } catch (err) {
      const htmlSnap = await page.content();
      fs.writeFileSync(`failed-row-${rowIndex}.html`, htmlSnap);
    } finally {
      if (!pageClosed && page && !page.isClosed()) {
        await page.close();
      }
    }
  }

  await browser.close();

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: updates },
    });
    console.log('✅ Sheet updated: pure bid values written to column Z');
  } else {
    console.log('ℹ️ No updates applied');
  }
})();
