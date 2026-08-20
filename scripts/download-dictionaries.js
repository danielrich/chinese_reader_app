#!/usr/bin/env node
/**
 * Dictionary Download Script
 *
 * Downloads dictionary data files from various sources:
 * - CC-CEDICT: Chinese-English dictionary
 * - MOE Dict: Taiwan Ministry of Education dictionary (via g0v)
 * - Word Frequencies: Character/word frequency data with HSK levels
 * - HanDeDict: German-Chinese dictionary (English translation)
 * - MakeMeaHanzi: Stroke order and character decomposition data
 *
 * Usage:
 *   node scripts/download-dictionaries.js [--all|--cedict|--moedict|--wordfreq|--handedict|--strokes]
 *
 * Data is downloaded to: src-tauri/data/
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const DATA_DIR = path.join(__dirname, '..', 'src-tauri', 'data');

const SOURCES = {
  cedict: {
    name: 'CC-CEDICT',
    url: 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz',
    filename: 'cedict.txt',
    compressed: 'gzip',
    description: 'Community-maintained Chinese-English dictionary (~160k entries)',
  },
  moedict: {
    name: 'MOE Dictionary (g0v)',
    url: 'https://raw.githubusercontent.com/g0v/moedict-data/master/dict-revised.json',
    filename: 'moedict.json',
    compressed: false,
    description: 'Taiwan Ministry of Education Revised Dictionary (~163k entries)',
  },
  wordfreq: {
    name: 'Chinese Word Frequencies',
    url: 'https://raw.githubusercontent.com/lxs602/Chinese-Mandarin-Dictionaries/master/Chinese%20Word%20Frequencies/Chinese%20Word%20Frequencies.tab.zip',
    filename: 'wordfreq.tab',
    compressed: 'zip',
    zipEntry: 'Chinese Word Frequencies.tab',
    description: 'Character/word frequency data from books, movies, internet + HSK levels',
  },
  handedict: {
    name: 'HanDeDict (English)',
    url: 'https://raw.githubusercontent.com/lxs602/Chinese-Mandarin-Dictionaries/master/HanDeDict%20(English%20machine%20translation)/handedict_en.tab.zip',
    filename: 'handedict.tab',
    compressed: 'zip',
    zipEntry: 'handedict_en.tab',
    description: 'German-Chinese dictionary with English translations (~83k entries)',
  },
  strokes: {
    name: 'MakeMeaHanzi (Strokes)',
    url: 'https://raw.githubusercontent.com/lxs602/Chinese-Mandarin-Dictionaries/master/MakeMeaHanzi%20(Stroke%20animations)/MakemeaHanzi.tab.zip',
    filename: 'strokes.tab',
    compressed: 'zip',
    zipEntry: 'MakemeaHanzi.tab',
    description: 'Stroke order and character decomposition data (~9k characters)',
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
 * Download a file from URL to a temporary or final path
 */
function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading: ${url}`);

    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        console.log(`Redirecting to: ${response.headers.location}`);
        downloadToFile(response.headers.location, destPath)
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

      const outputStream = fs.createWriteStream(destPath);

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (totalSize) {
          const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
          process.stdout.write(`\rProgress: ${percent}% (${(downloadedSize / 1024 / 1024).toFixed(2)} MB)`);
        }
      });

      response.pipe(outputStream);

      outputStream.on('finish', () => {
        console.log('\nDownload complete!');
        resolve();
      });

      outputStream.on('error', reject);
      response.on('error', reject);
    });

    request.on('error', reject);
    request.setTimeout(120000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * Download and decompress a file based on compression type
 */
async function downloadFile(url, destPath, compressed, zipEntry = null) {
  if (compressed === 'zip') {
    // Download zip to temp file, then extract
    const tempZip = destPath + '.zip';
    await downloadToFile(url, tempZip);

    console.log(`Extracting: ${zipEntry || 'first file'}...`);
    try {
      // Extract specific file from zip
      if (zipEntry) {
        execSync(`unzip -p "${tempZip}" "${zipEntry}" > "${destPath}"`, { stdio: 'pipe' });
      } else {
        execSync(`unzip -p "${tempZip}" > "${destPath}"`, { stdio: 'pipe' });
      }
      fs.unlinkSync(tempZip);
      console.log('Extraction complete!');
    } catch (err) {
      fs.unlinkSync(tempZip);
      throw new Error(`Failed to extract zip: ${err.message}`);
    }
  } else if (compressed === 'gzip') {
    // Stream decompress gzip
    const tempGz = destPath + '.gz';
    await downloadToFile(url, tempGz);

    console.log('Decompressing...');
    await new Promise((resolve, reject) => {
      const gunzip = zlib.createGunzip();
      const input = fs.createReadStream(tempGz);
      const output = fs.createWriteStream(destPath);

      input.pipe(gunzip).pipe(output);
      output.on('finish', () => {
        fs.unlinkSync(tempGz);
        console.log('Decompression complete!');
        resolve();
      });
      output.on('error', reject);
      gunzip.on('error', reject);
    });
  } else {
    // No compression, download directly
    await downloadToFile(url, destPath);
  }
}

/**
 * Check if a file exists and has content
 */
function fileExists(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.size > 0;
  } catch {
    return false;
  }
}

/**
 * Download a specific dictionary source (skips if already exists)
 */
async function downloadSource(key, forceDownload = false) {
  const source = SOURCES[key];
  if (!source) {
    console.error(`Unknown source: ${key}`);
    return false;
  }

  const destPath = path.join(DATA_DIR, source.filename);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${source.name}`);
  console.log(`Description: ${source.description}`);
  console.log(`Destination: ${destPath}`);
  console.log('='.repeat(60));

  // Check if file already exists
  if (!forceDownload && fileExists(destPath)) {
    const stats = fs.statSync(destPath);
    console.log(`Already exists (${(stats.size / 1024 / 1024).toFixed(2)} MB) - skipping download`);
    return true;
  }

  try {
    await downloadFile(source.url, destPath, source.compressed, source.zipEntry);

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
    console.log('Usage: node download-dictionaries.js [--all|--cedict|--moedict|--wordfreq|--handedict|--strokes]');
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
