#!/usr/bin/env node
/**
 * Dictionary Download Script
 *
 * Downloads dictionary data files from various sources:
 * - CC-CEDICT: Chinese-English dictionary
 * - MOE Dict: Taiwan Ministry of Education dictionary (via g0v)
 * - Kangxi: Kangxi dictionary text file
 *
 * Usage:
 *   node scripts/download-dictionaries.js [--all|--cedict|--moedict|--kangxi]
 *
 * Data is downloaded to: src-tauri/data/
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Configuration
const DATA_DIR = path.join(__dirname, '..', 'src-tauri', 'data');

const SOURCES = {
  cedict: {
    name: 'CC-CEDICT',
    url: 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz',
    filename: 'cedict.txt',
    compressed: true,
    description: 'Community-maintained Chinese-English dictionary (~160k entries)',
  },
  moedict: {
    name: 'MOE Dictionary (g0v)',
    url: 'https://raw.githubusercontent.com/g0v/moedict-data/master/dict-revised.json',
    filename: 'moedict.json',
    compressed: false,
    description: 'Taiwan Ministry of Education Revised Dictionary (~163k entries)',
  },
  kangxi: {
    name: 'Kangxi Dictionary',
    url: 'https://raw.githubusercontent.com/7468696e6b/kangxiDictText/master/kangxiDictText_utf8.txt',
    filename: 'kangxi.txt',
    compressed: false,
    description: 'Historical character dictionary',
  },
};

/**
 * Ensure directory exists
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
}

/**
 * Download a file from URL
 */
function downloadFile(url, destPath, compressed = false) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading: ${url}`);

    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        console.log(`Redirecting to: ${response.headers.location}`);
        downloadFile(response.headers.location, destPath, compressed)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        return;
      }

      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;

      // Set up output stream
      let outputStream;
      if (compressed) {
        outputStream = zlib.createGunzip();
        outputStream.pipe(fs.createWriteStream(destPath));
      } else {
        outputStream = fs.createWriteStream(destPath);
      }

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (totalSize) {
          const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
          process.stdout.write(`\rProgress: ${percent}% (${(downloadedSize / 1024 / 1024).toFixed(2)} MB)`);
        }
      });

      if (compressed) {
        response.pipe(outputStream);
      } else {
        response.pipe(outputStream);
      }

      outputStream.on('finish', () => {
        console.log('\nDownload complete!');
        resolve();
      });

      outputStream.on('error', reject);
      response.on('error', reject);
    });

    request.on('error', reject);
    request.setTimeout(60000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * Download a specific dictionary source
 */
async function downloadSource(key) {
  const source = SOURCES[key];
  if (!source) {
    console.error(`Unknown source: ${key}`);
    return false;
  }

  const destPath = path.join(DATA_DIR, source.filename);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Downloading: ${source.name}`);
  console.log(`Description: ${source.description}`);
  console.log(`Destination: ${destPath}`);
  console.log('='.repeat(60));

  try {
    await downloadFile(source.url, destPath, source.compressed);

    // Verify file exists and has content
    const stats = fs.statSync(destPath);
    console.log(`File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    return true;
  } catch (error) {
    console.error(`Failed to download ${source.name}: ${error.message}`);
    return false;
  }
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);

  // Determine which sources to download
  let sourcesToDownload = [];

  if (args.length === 0 || args.includes('--all')) {
    sourcesToDownload = Object.keys(SOURCES);
  } else {
    for (const arg of args) {
      const key = arg.replace('--', '');
      if (SOURCES[key]) {
        sourcesToDownload.push(key);
      } else if (arg.startsWith('--')) {
        console.warn(`Unknown option: ${arg}`);
      }
    }
  }

  if (sourcesToDownload.length === 0) {
    console.log('Usage: node download-dictionaries.js [--all|--cedict|--moedict|--kangxi]');
    console.log('\nAvailable sources:');
    for (const [key, source] of Object.entries(SOURCES)) {
      console.log(`  --${key}: ${source.name} - ${source.description}`);
    }
    process.exit(1);
  }

  // Ensure data directory exists
  ensureDir(DATA_DIR);

  console.log(`\nDownloading ${sourcesToDownload.length} dictionary source(s)...`);

  const results = {};
  for (const key of sourcesToDownload) {
    results[key] = await downloadSource(key);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Download Summary:');
  console.log('='.repeat(60));

  let allSuccess = true;
  for (const [key, success] of Object.entries(results)) {
    const status = success ? '✓' : '✗';
    console.log(`  ${status} ${SOURCES[key].name}`);
    if (!success) allSuccess = false;
  }

  if (allSuccess) {
    console.log('\nAll downloads completed successfully!');
    console.log(`\nData files are in: ${DATA_DIR}`);
    console.log('\nNext step: Run the import command to load dictionaries into the database.');
  } else {
    console.log('\nSome downloads failed. Please check the errors above.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
