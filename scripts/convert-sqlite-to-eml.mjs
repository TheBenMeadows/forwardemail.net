// Original script by Forward Email LLC
// Almost completely rewritten by @TheBenMeadows

// How to use this script to convert your .sqlite backup to .eml files:
// git clone https://github.com/forwardemail/forwardemail.net.git
// cd forwardemail.net
// npm install
// touch .env
// nano .env
// create the following 3 lines in the .env file and save:
//   SQLITE_PATH="local path to your .sqlite db backup file"
//   SQLITE_PASSWORD='your password for the alias account'
//   ALIAS_ID="this should be the same as your db file (less the .sqlite at the end)"
// dotenv -e .env -- node scripts/convert-sqlite-to-eml.mjs

// Import modules using ES Module syntax
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import punycode from 'node:punycode';
import { randomUUID } from 'node:crypto';
import sqlite3 from 'better-sqlite3-multiple-ciphers';
import dotenv from 'dotenv';
import chalk from 'chalk';
import he from 'he';

dotenv.config();

const { SQLITE_PATH, SQLITE_PASSWORD, ALIAS_ID } = process.env;

if (!SQLITE_PATH || !SQLITE_PASSWORD || !ALIAS_ID) {
  console.error(chalk.red('❌ Required environment variables missing.'));
  process.exit(1);
}

// Utility function to normalize text encoding
const normalizeEncoding = (text) => {
  if (!text) return '';
  return text
    .replace(/\uFEFF/g, '') // Remove BOM
    .replace(/[\u00A0]/g, ' ') // Replace non-breaking spaces
    .replace(/â¯/g, ' ') // Fix specific encoding issues
    .replace(/â/g, "'") // Fix apostrophes
    .replace(/Â/g, ''); // Remove unnecessary spaces
};

// Enhanced email content processing
const processEmailContent = (mimeTree, attachments) => {
  const generateBoundary = () => `----=_Part_${randomUUID().replace(/-/g, '')}`;
  const mainBoundary = generateBoundary();

  // Reconstruct email headers
  const reconstructHeaders = (msg) => {
    const headers = [];
    if (msg.from) headers.push(`From: ${normalizeEncoding(msg.from)}`);
    if (msg.subject) headers.push(`Subject: ${normalizeEncoding(msg.subject)}`);
    if (msg.to) headers.push(`To: ${normalizeEncoding(msg.to)}`);
    if (msg.date) {
      const date = new Date(msg.date);
      headers.push(`Date: ${date.toUTCString()}`);
    }
    headers.push('MIME-Version: 1.0');
    return headers;
  };

  const parseNode = (node, parentContentType = null) => {
    if (!node) return '';

    const headers = [];
    const nodeHeaders = new Map();
    let contentType = '';
    let boundary = '';

    // Process existing headers
    if (node.header && Array.isArray(node.header)) {
      for (const headerLine of node.header) {
        const [key, ...valueParts] = headerLine.split(':');
        if (!key) continue;

        const value = valueParts.join(':').trim();
        const normalizedKey = key.trim().toLowerCase();
        nodeHeaders.set(normalizedKey, value);

        const cleanHeader = `${key.trim()}: ${normalizeEncoding(value)}`;
        headers.push(cleanHeader);

        if (normalizedKey === 'content-type') {
          contentType = value;
          const boundaryMatch = value.match(/boundary="?([^";\s]+)"?/i);
          if (boundaryMatch) {
            boundary = boundaryMatch[1];
          }
        }
      }
    }

    // Set appropriate content type if not present
    if (!contentType) {
      if (
        node.body &&
        typeof node.body === 'string' &&
        node.body.trim().toLowerCase().startsWith('<!doctype html')
      ) {
        contentType = 'text/html; charset=UTF-8';
        headers.push(`Content-Type: ${contentType}`);
      } else if (node.body) {
        contentType = 'text/plain; charset=UTF-8';
        headers.push(`Content-Type: ${contentType}`);
      }
    }

    // Add transfer encoding if needed
    if (!nodeHeaders.has('content-transfer-encoding')) {
      headers.push('Content-Transfer-Encoding: quoted-printable');
    }

    // Process body
    let bodyContent = '';
    if (node.body) {
      if (Buffer.isBuffer(node.body)) {
        bodyContent = node.body.toString('utf-8');
      } else if (typeof node.body === 'string') {
        bodyContent = node.body;
      } else if (typeof node.body === 'object') {
        if (node.body.type === 'Buffer' && Array.isArray(node.body.data)) {
          bodyContent = Buffer.from(node.body.data).toString('utf-8');
        } else if (node.body.content) {
          bodyContent = node.body.content;
        }
      }

      if (contentType.includes('text/html')) {
        bodyContent = he.decode(bodyContent);
      }

      bodyContent = normalizeEncoding(bodyContent);
    }

    const nodeParts = [...headers, '', bodyContent];

    // Handle attachments
    if (node.attachmentId && attachments[node.attachmentId]) {
      const attachment = attachments[node.attachmentId];
      const attachmentBoundary = boundary || generateBoundary();

      if (!contentType.startsWith('multipart/')) {
        const newBoundary = generateBoundary();
        nodeParts.unshift(
          `Content-Type: multipart/mixed; boundary="${newBoundary}"`,
          '',
          `--${newBoundary}`,
          `Content-Type: ${contentType}`,
          headers.find((h) =>
            h.toLowerCase().startsWith('content-transfer-encoding:')
          ) || 'Content-Transfer-Encoding: quoted-printable',
          ''
        );
        nodeParts.push(`--${newBoundary}`);
        boundary = newBoundary;
      } else {
        nodeParts.push(`--${boundary}`);
      }

      nodeParts.push(
        `Content-Type: ${attachment.contentType}; name="${attachment.name}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${attachment.name}"`,
        '',
        attachment.content
          .toString('base64')
          .match(/.{1,76}/g)
          .join('\r\n'),
        '',
        `--${boundary}--\r\n`
      );
    }

    // Handle child nodes
    if (node.childNodes && node.childNodes.length > 0) {
      if (contentType.startsWith('multipart/')) {
        const subBoundary = boundary || generateBoundary();

        if (!boundary) {
          const contentTypeHeader = nodeParts.findIndex((p) =>
            p.startsWith('Content-Type:')
          );
          if (contentTypeHeader !== -1) {
            nodeParts[
              contentTypeHeader
            ] = `Content-Type: ${contentType}; boundary="${subBoundary}"`;
          } else {
            nodeParts.unshift(
              `Content-Type: ${contentType}; boundary="${subBoundary}"`
            );
          }
        }

        nodeParts.push('');
        for (let i = 0; i < node.childNodes.length; i++) {
          nodeParts.push(`--${subBoundary}`);
          nodeParts.push(parseNode(node.childNodes[i], contentType));
        }
        nodeParts.push(`--${subBoundary}--`);
      } else {
        for (const childNode of node.childNodes) {
          nodeParts.push(parseNode(childNode, contentType));
        }
      }
    }

    return nodeParts.join('\r\n');
  };

  // Build complete email
  const hasAttachments =
    mimeTree.attachmentId ||
    (mimeTree.childNodes &&
      mimeTree.childNodes.some((node) => node.attachmentId));

  const emailParts = [];
  emailParts.push(...reconstructHeaders(mimeTree));

  if (hasAttachments) {
    emailParts.push(
      `Content-Type: multipart/mixed; boundary="${mainBoundary}"`
    );
    emailParts.push('');
    emailParts.push('This is a multi-part message in MIME format.');
    emailParts.push('');
    emailParts.push(`--${mainBoundary}`);
  }

  emailParts.push(parseNode(mimeTree));

  if (hasAttachments) {
    emailParts.push(`--${mainBoundary}--`);
  }

  return emailParts.join('\r\n').trim() + '\r\n';
};

// Main export function
(async () => {
  let db;
  try {
    console.log(chalk.yellow('🔄 Starting email export process...'));

    // Initialize database with proper encryption settings
    db = new sqlite3(SQLITE_PATH, { readonly: true });
    db.pragma(`key='${SQLITE_PASSWORD}'`);
    db.pragma('cipher=sqlcipher');
    db.pragma('legacy=3');
    console.log(chalk.green('✅ Connected to SQLite Database'));

    console.log(chalk.yellow('📎 Loading attachments...'));

    // Create output directory
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const outputDir = path.join(
      os.homedir(),
      'Downloads',
      `email-export-${ALIAS_ID}-${timestamp}`
    );
    fs.mkdirSync(outputDir, { recursive: true });

    // Create attachments directory
    const attachmentDir = path.join(outputDir, '_attachments');
    fs.mkdirSync(attachmentDir, { recursive: true });

    const attachments = {};
    const attachmentRows = db
      .prepare(
        `
        SELECT _id, attachmentId, contentType, transferEncoding,
               hash, size, body
        FROM Attachments
      `
      )
      .raw()
      .all();

    // Utility function to decode hex
    const decodeHex = (str) => {
      const cleaned = str.replace(/[\r\n\s]+/g, '');
      if (!/^[0-9A-Fa-f]+$/.test(cleaned)) return null;
      return Buffer.from(cleaned, 'hex');
    };

    // Debug-enabled decode function
    const decodeContent = (body, transferEncoding, debugPrefix) => {
      if (!body) return null;

      try {
        // Save the original content
        fs.writeFileSync(`${debugPrefix}_1_original.txt`, body);
        console.log('Original content length:', body.length);
        console.log('First 50 chars:', body.slice(0, 50));

        // First, decode the hex encoding
        const hexDecoded = decodeHex(body);
        if (!hexDecoded) {
          console.log('Failed hex decode, trying direct methods');
          return Buffer.from(body);
        }

        // Save hex decoded content
        fs.writeFileSync(`${debugPrefix}_2_hexdecoded.txt`, hexDecoded);
        console.log('Hex decoded length:', hexDecoded.length);
        console.log(
          'First 50 bytes hex:',
          hexDecoded.slice(0, 50).toString('hex')
        );

        // Convert hex-decoded buffer to string
        const hexDecodedStr = hexDecoded.toString('utf8');
        fs.writeFileSync(`${debugPrefix}_3_hextostr.txt`, hexDecodedStr);
        console.log('Hex->string length:', hexDecodedStr.length);
        console.log('First 50 chars:', hexDecodedStr.slice(0, 50));

        let finalContent;
        // Now handle the transfer encoding
        switch (transferEncoding.toLowerCase()) {
          case 'base64':
            console.log('Applying base64 decode after hex');
            // Remove any whitespace that might have survived
            const cleanBase64 = hexDecodedStr.replace(/[\r\n\s]+/g, '');
            fs.writeFileSync(`${debugPrefix}_4_cleanbase64.txt`, cleanBase64);
            console.log('Clean base64 length:', cleanBase64.length);
            console.log('First 50 chars of base64:', cleanBase64.slice(0, 50));

            finalContent = Buffer.from(cleanBase64, 'base64');
            break;

          case '7bit':
          case '8bit':
          case 'binary':
            console.log('Using hex decoded content directly');
            finalContent = hexDecoded;
            break;

          case 'quoted-printable':
            console.log('Applying quoted-printable decode after hex');
            finalContent = Buffer.from(hexDecodedStr);
            break;

          default:
            console.warn(
              `Unknown transfer encoding: ${transferEncoding}, using hex decoded`
            );
            finalContent = hexDecoded;
        }

        // Save final content in different formats
        fs.writeFileSync(`${debugPrefix}_5_final.bin`, finalContent);
        fs.writeFileSync(
          `${debugPrefix}_5_final.hex`,
          finalContent.toString('hex')
        );
        fs.writeFileSync(
          `${debugPrefix}_5_final.b64`,
          finalContent.toString('base64')
        );

        // For PDFs, check for PDF signature
        if (finalContent.length > 4) {
          console.log(
            'Final content first 4 bytes:',
            Array.from(finalContent.slice(0, 4))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(' ')
          );
        }

        return finalContent;
      } catch (err) {
        console.error('Decode error:', err);
        return null;
      }
    };

    // Process each attachment
    for (const [
      _id,
      attachmentId,
      contentType,
      transferEncoding,
      hash,
      size,
      body
    ] of attachmentRows) {
      try {
        if (!body) {
          console.warn(
            chalk.yellow(`⚠️ Skipping attachment ${attachmentId} - no data`)
          );
          continue;
        }

        console.log(
          '\n' + chalk.cyan(`🔍 Processing Attachment ${attachmentId}`)
        );
        console.log(`Content Type: ${contentType}`);
        console.log(`Transfer Encoding: ${transferEncoding}`);
        console.log(`Original size: ${size} bytes`);

        // Debug decode with prefix
        const debugPrefix = path.join(
          attachmentDir,
          `${hash || _id}_${attachmentId}_debug`
        );
        const content = decodeContent(body, transferEncoding, debugPrefix);

        if (!content) {
          console.error(
            chalk.red(`Failed to decode attachment ${attachmentId}`)
          );
          continue;
        }

        // Get proper file extension and save file
        let fileExt = '';
        if (contentType) {
          const mimeType = contentType.split(';')[0].trim().toLowerCase();
          const ext = mimeType.split('/')[1];
          if (ext && !ext.includes('*')) {
            fileExt = `.${ext}`;
          }
        }

        const fileName = `${hash || _id}_${attachmentId}${fileExt}`;
        const filePath = path.join(attachmentDir, fileName);
        fs.writeFileSync(filePath, content, { encoding: null });

        // Store in attachments map
        attachments[attachmentId] = {
          content,
          contentType: contentType || 'application/octet-stream',
          name: fileName,
          size: content.length
        };

        // Log results
        if (size && content.length !== size) {
          console.warn(
            chalk.yellow(
              `⚠️ Size mismatch for ${fileName} - Expected: ${size}, Got: ${content.length}`
            )
          );
        } else {
          console.log(
            chalk.green(
              `✓ Saved attachment ${attachmentId} (${content.length} bytes) as ${fileName}`
            )
          );
        }
      } catch (err) {
        console.error(
          chalk.red(
            `❌ Error processing attachment ${attachmentId}:`,
            err.message
          )
        );
        if (err.stack) console.error(chalk.red(err.stack));
      }
    }

    console.log(
      chalk.blue(`📎 Processed ${Object.keys(attachments).length} attachments`)
    );

    // Load mailboxes
    console.log(chalk.yellow('📫 Loading mailboxes...'));
    const mailboxMap = new Map();
    const mailboxRows = db.prepare('SELECT _id, path FROM Mailboxes').all();
    console.log(chalk.blue(`📫 Found ${mailboxRows.length} mailboxes`));

    for (const mailbox of mailboxRows) {
      const safeMailboxPath = punycode.toASCII(mailbox.path);
      const fullMailboxPath = path.join(outputDir, safeMailboxPath);
      mailboxMap.set(mailbox._id, safeMailboxPath);
      console.log(
        chalk.yellow(`📁 Creating mailbox directory: ${safeMailboxPath}`)
      );
      fs.mkdirSync(fullMailboxPath, { recursive: true });
    }

    // Process Messages
    console.log(chalk.yellow('📧 Loading messages...'));
    const messageRows = db
      .prepare(
        'SELECT _id, mailbox, msgid, subject, mimeTree FROM Messages ORDER BY uid'
      )
      .all();
    console.log(
      chalk.blue(`📧 Found ${messageRows.length} messages to process`)
    );

    let processedCount = 0;
    let errorCount = 0;
    const startTime = Date.now();

    for (const message of messageRows) {
      try {
        const mailboxPath = mailboxMap.get(message.mailbox) || 'unknown';
        const fileName = `${message._id}.eml`;
        const filePath = path.join(outputDir, mailboxPath, fileName);

        let mimeTree;
        try {
          mimeTree = JSON.parse(message.mimeTree);
          if (Array.isArray(mimeTree.header)) {
            mimeTree.subject = message.subject;

            mimeTree.header.forEach((header) => {
              const [key, ...valueParts] = header.split(':');
              const value = valueParts.join(':').trim();
              const lowerKey = key.toLowerCase().trim();

              switch (lowerKey) {
                case 'from':
                  mimeTree.from = value;
                  break;
                case 'to':
                  mimeTree.to = value;
                  break;
                case 'date':
                  mimeTree.date = value;
                  break;
              }
            });
          }
        } catch (parseError) {
          console.error(
            chalk.red(
              `Failed to parse MIME tree for message ${message._id}:`,
              parseError
            )
          );
          continue;
        }

        const emailContent = processEmailContent(mimeTree, attachments);

        if (emailContent.trim()) {
          fs.writeFileSync(filePath, emailContent);
          processedCount++;

          if (processedCount === 1) {
            console.log(chalk.cyan('\n📧 First message content preview:'));
            console.log(emailContent.slice(0, 500));
          }

          if (processedCount % 100 === 0) {
            const elapsedTime = (Date.now() - startTime) / 1000;
            const averageTime = elapsedTime / processedCount;
            const remaining = messageRows.length - processedCount;
            const estimatedRemainingTime = averageTime * remaining;

            console.log(
              chalk.yellow(
                `📨 Processed ${processedCount}/${messageRows.length} messages`
              ) +
                chalk.gray(
                  ` (${((processedCount / messageRows.length) * 100).toFixed(
                    2
                  )}%)`
                ) +
                chalk.gray(
                  ` - Est. remaining: ${Math.round(
                    estimatedRemainingTime
                  )} seconds`
                )
            );
          }
        }
      } catch (err) {
        errorCount++;
        console.error(
          chalk.red(
            `\n❌ Error processing message ${message._id}:`,
            err.message
          )
        );
        if (errorCount <= 5 && err.stack) {
          console.error(chalk.red(err.stack));
        }
      }
    }

    // Final export summary
    console.log(chalk.green('\n✅ Export completed:'));
    console.log(chalk.white(`📊 Total messages: ${messageRows.length}`));
    console.log(chalk.green(`✓ Successfully processed: ${processedCount}`));
    console.log(chalk.red(`⚠️ Errors: ${errorCount}`));
    console.log(chalk.blue(`📁 Exported to: ${outputDir}`));
  } catch (err) {
    console.error(chalk.red('\n❌ Fatal error:'), err);
    if (err.stack) console.error(chalk.red(err.stack));
    process.exit(1);
  } finally {
    if (db) {
      console.log(chalk.yellow('🔒 Closing database connection...'));
      db.close();
    }
  }
})();
