#!/usr/bin/env npx tsx
/**
 * Contact Processing Script
 *
 * Combines Google and Apple contacts, removes duplicates, filters trash,
 * and outputs cleaned VCF files for both services.
 *
 * Usage: npx tsx process-contacts.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

interface Contact {
  id: string;
  source: 'google' | 'apple';
  raw: string;
  fn: string;
  n?: {
    familyName: string;
    givenName: string;
    additionalNames: string;
    honorificPrefixes: string;
    honorificSuffixes: string;
  };
  emails: string[];
  phones: string[];
  org: string[];
  title: string;
  note: string;
  photo: string;
  bday: string;
  urls: string[];
  addresses: Array<{
    type: string[];
    poBox: string;
    extendedAddress: string;
    streetAddress: string;
    locality: string;
    region: string;
    postalCode: string;
    countryName: string;
  }>;
  otherProperties: Map<string, string[]>;
}

interface ProcessingStats {
  googleTotal: number;
  appleTotal: number;
  combinedTotal: number;
  filteredOut: number;
  duplicatesMerged: number;
  finalCount: number;
  filterReasons: Map<string, number>;
}

// ============================================================================
// VCF Parser
// ============================================================================

function unfoldLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const unfoldedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    while (i + 1 < lines.length && (lines[i + 1].startsWith(' ') || lines[i + 1].startsWith('\t'))) {
      i++;
      line += lines[i].substring(1);
    }

    if (line.trim()) {
      unfoldedLines.push(line.trim());
    }
  }

  return unfoldedLines;
}

function unescapeVCardValue(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\r/gi, '\r')
    .replace(/\\:/g, ':')
    .replace(/\\;/g, ';')
    .replace(/\\,/g, ',')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function parsePropertyLine(line: string): { name: string; value: string; params: Record<string, string> } | null {
  const colonIndex = line.indexOf(':');
  if (colonIndex === -1) return null;

  const nameAndParams = line.substring(0, colonIndex);
  const value = line.substring(colonIndex + 1);

  // Handle grouped properties (e.g., item1.TEL)
  let nameWithParams = nameAndParams;
  const dotIndex = nameAndParams.indexOf('.');
  if (dotIndex !== -1) {
    nameWithParams = nameAndParams.substring(dotIndex + 1);
  }

  const parts = nameWithParams.split(';');
  const name = parts[0].toUpperCase();
  const params: Record<string, string> = {};

  for (let i = 1; i < parts.length; i++) {
    const param = parts[i];
    const equalIndex = param.indexOf('=');
    if (equalIndex === -1) {
      params[param.toUpperCase()] = '';
    } else {
      const paramName = param.substring(0, equalIndex).toUpperCase();
      const paramValue = param.substring(equalIndex + 1).replace(/^"(.*)"$/, '$1');
      params[paramName] = paramValue;
    }
  }

  return { name, value: unescapeVCardValue(value), params };
}

function parseVCard(vcardContent: string, source: 'google' | 'apple'): Contact | null {
  const lines = unfoldLines(vcardContent);

  if (lines.length === 0 || !lines[0].startsWith('BEGIN:VCARD')) {
    return null;
  }

  const contact: Contact = {
    id: `${source}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    source,
    raw: vcardContent,
    fn: '',
    emails: [],
    phones: [],
    org: [],
    title: '',
    note: '',
    photo: '',
    bday: '',
    urls: [],
    addresses: [],
    otherProperties: new Map(),
  };

  for (const line of lines) {
    if (line === 'BEGIN:VCARD' || line === 'END:VCARD') continue;

    const parsed = parsePropertyLine(line);
    if (!parsed) continue;

    const { name, value, params } = parsed;

    switch (name) {
      case 'FN':
        contact.fn = value;
        break;

      case 'N':
        const nParts = value.split(';');
        contact.n = {
          familyName: nParts[0] || '',
          givenName: nParts[1] || '',
          additionalNames: nParts[2] || '',
          honorificPrefixes: nParts[3] || '',
          honorificSuffixes: nParts[4] || '',
        };
        break;

      case 'TEL':
        const phone = normalizePhone(value);
        if (phone && !contact.phones.includes(phone)) {
          contact.phones.push(phone);
        }
        break;

      case 'EMAIL':
        const email = value.toLowerCase().trim();
        if (email && !contact.emails.includes(email)) {
          contact.emails.push(email);
        }
        break;

      case 'URL':
        if (value && !contact.urls.includes(value)) {
          contact.urls.push(value);
        }
        break;

      case 'ORG':
        const orgs = value.split(';').filter(o => o.trim());
        contact.org = orgs;
        break;

      case 'TITLE':
        contact.title = value;
        break;

      case 'NOTE':
        contact.note = value;
        break;

      case 'PHOTO':
        contact.photo = value;
        break;

      case 'BDAY':
        contact.bday = value;
        break;

      case 'ADR':
        const adrParts = value.split(';');
        const typeStr = params.TYPE || '';
        contact.addresses.push({
          type: typeStr.split(',').filter(t => t),
          poBox: adrParts[0] || '',
          extendedAddress: adrParts[1] || '',
          streetAddress: adrParts[2] || '',
          locality: adrParts[3] || '',
          region: adrParts[4] || '',
          postalCode: adrParts[5] || '',
          countryName: adrParts[6] || '',
        });
        break;

      case 'UID':
        contact.id = value;
        break;

      default:
        // Store other properties for preservation
        if (!contact.otherProperties.has(name)) {
          contact.otherProperties.set(name, []);
        }
        contact.otherProperties.get(name)!.push(line);
        break;
    }
  }

  // Fix mangled contacts (CSV data in name fields)
  if (isMangledContact(contact)) {
    fixMangledContact(contact);
  }

  // Extract structured data from notes field
  extractDataFromNote(contact);

  return contact;
}

function parseVCFFile(content: string, source: 'google' | 'apple'): Contact[] {
  const contacts: Contact[] = [];

  const vcardBlocks = content.split(/(?=BEGIN:VCARD)/g)
    .map(block => block.trim())
    .filter(block => block.startsWith('BEGIN:VCARD'));

  for (const block of vcardBlocks) {
    const contact = parseVCard(block, source);
    if (contact) {
      contacts.push(contact);
    }
  }

  return contacts;
}

// ============================================================================
// Mangled Contact Fixer
// ============================================================================

function isMangledContact(contact: Contact): boolean {
  const fn = contact.fn;
  const csvPattern = /\\,/g;
  const fnEscapes = (fn.match(csvPattern) || []).length;
  return fnEscapes >= 5;
}

function fixMangledContact(contact: Contact): void {
  const parts = contact.fn.split('\\,');

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Email pattern
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (emailRegex.test(trimmed)) {
      const email = trimmed.toLowerCase();
      if (!contact.emails.includes(email)) {
        contact.emails.push(email);
      }
      continue;
    }

    // Phone pattern
    const digitsOnly = trimmed.replace(/\D/g, '');
    if (digitsOnly.length >= 7 && digitsOnly.length <= 15) {
      const phoneChars = trimmed.replace(/[\d\s\(\)\-\+\.]/g, '');
      if (phoneChars.length <= 2) {
        const phone = normalizePhone(trimmed);
        if (phone && !contact.phones.includes(phone)) {
          contact.phones.push(phone);
        }
        continue;
      }
    }
  }

  // Try to generate a reasonable name from email
  if (contact.emails.length > 0) {
    const email = contact.emails[0];
    const localPart = email.split('@')[0];

    if (localPart.includes('.')) {
      const nameParts = localPart.split('.');
      contact.fn = nameParts
        .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
        .join(' ');
    } else if (localPart.includes('_')) {
      const nameParts = localPart.split('_');
      contact.fn = nameParts
        .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
        .join(' ');
    } else if (localPart.length > 2 && !/^\d+$/.test(localPart)) {
      contact.fn = localPart.charAt(0).toUpperCase() + localPart.slice(1);
    }
  }
}

// ============================================================================
// Note Field Parser
// ============================================================================

/**
 * Extract structured contact data from the notes field.
 * Many contacts have info like "Email: foo@bar.com\nPhone: 555-1234" in notes.
 * If we find structured data, merge it into proper fields and clear the note.
 */
function extractDataFromNote(contact: Contact): void {
  if (!contact.note || !contact.note.trim()) return;

  const note = contact.note;
  let foundStructuredData = false;

  // Common label patterns for structured notes
  const emailLabels = /(?:e-?mail|courriel|correo)\s*[:\-]\s*/gi;
  const phoneLabels = /(?:phone|tel(?:ephone)?|mobile|cell|fax|work|home)\s*[:\-]\s*/gi;
  const urlLabels = /(?:web(?:site)?|url|homepage|home page|site)\s*[:\-]\s*/gi;
  const orgLabels = /(?:company|organization|org|employer|work)\s*[:\-]\s*/gi;
  const titleLabels = /(?:title|position|role|job)\s*[:\-]\s*/gi;
  const nameLabels = /(?:first name|last name|name|given name|family name|surname)\s*[:\-]\s*/gi;

  // Check if note looks structured (has labeled fields)
  const hasLabels = emailLabels.test(note) || phoneLabels.test(note) ||
                    urlLabels.test(note) || orgLabels.test(note) ||
                    titleLabels.test(note) || nameLabels.test(note);

  // Also check for key: value patterns
  const keyValuePattern = /^[A-Za-z\s]+[:\-]\s*.+$/m;
  const hasKeyValuePairs = keyValuePattern.test(note);

  if (!hasLabels && !hasKeyValuePairs) {
    // Doesn't look like structured data, might be a real note
    return;
  }

  // Split into lines and process
  const lines = note.split(/[\r\n]+/).map(l => l.trim()).filter(l => l);

  // Track what we extract
  const extractedEmails: string[] = [];
  const extractedPhones: string[] = [];
  const extractedUrls: string[] = [];
  const extractedOrgs: string[] = [];
  let extractedTitle = '';
  let extractedFirstName = '';
  let extractedLastName = '';
  const remainingLines: string[] = [];

  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const phoneRegex = /(?:\+?[\d\s\(\)\-\.]{7,20})/g;
  const urlRegex = /https?:\/\/[^\s,]+/gi;

  for (const line of lines) {
    let processed = false;
    const lineLower = line.toLowerCase();

    // Check for email labels
    if (/(?:e-?mail|courriel|correo)\s*[:\-]/i.test(line)) {
      const emails = line.match(emailRegex);
      if (emails) {
        extractedEmails.push(...emails.map(e => e.toLowerCase()));
        foundStructuredData = true;
        processed = true;
      }
    }

    // Check for phone labels
    if (/(?:phone|tel(?:ephone)?|mobile|cell|fax)\s*[:\-]/i.test(line)) {
      const afterLabel = line.replace(/^[^:\-]+[:\-]\s*/, '');
      const phones = afterLabel.match(phoneRegex);
      if (phones) {
        extractedPhones.push(...phones);
        foundStructuredData = true;
        processed = true;
      }
    }

    // Check for URL labels
    if (/(?:web(?:site)?|url|homepage|home page|site)\s*[:\-]/i.test(line)) {
      const urls = line.match(urlRegex);
      if (urls) {
        extractedUrls.push(...urls);
        foundStructuredData = true;
        processed = true;
      }
    }

    // Check for organization labels
    if (/(?:company|organization|org|employer)\s*[:\-]/i.test(line)) {
      const afterLabel = line.replace(/^[^:\-]+[:\-]\s*/, '').trim();
      if (afterLabel && afterLabel.length > 1) {
        extractedOrgs.push(afterLabel);
        foundStructuredData = true;
        processed = true;
      }
    }

    // Check for title labels
    if (/(?:title|position|role|job)\s*[:\-]/i.test(line)) {
      const afterLabel = line.replace(/^[^:\-]+[:\-]\s*/, '').trim();
      if (afterLabel && afterLabel.length > 1) {
        extractedTitle = afterLabel;
        foundStructuredData = true;
        processed = true;
      }
    }

    // Check for name labels
    if (/first\s*name\s*[:\-]/i.test(line)) {
      const afterLabel = line.replace(/^[^:\-]+[:\-]\s*/, '').trim();
      if (afterLabel) {
        extractedFirstName = afterLabel;
        foundStructuredData = true;
        processed = true;
      }
    }
    if (/last\s*name\s*[:\-]/i.test(line) || /surname\s*[:\-]/i.test(line) || /family\s*name\s*[:\-]/i.test(line)) {
      const afterLabel = line.replace(/^[^:\-]+[:\-]\s*/, '').trim();
      if (afterLabel) {
        extractedLastName = afterLabel;
        foundStructuredData = true;
        processed = true;
      }
    }

    // Also scan for unlabeled emails/phones/urls in the line
    if (!processed) {
      const emails = line.match(emailRegex);
      const urls = line.match(urlRegex);

      if (emails && emails.length > 0) {
        extractedEmails.push(...emails.map(e => e.toLowerCase()));
        foundStructuredData = true;
        processed = true;
      }
      if (urls && urls.length > 0) {
        extractedUrls.push(...urls);
        foundStructuredData = true;
        processed = true;
      }
    }

    if (!processed) {
      remainingLines.push(line);
    }
  }

  // Merge extracted data into contact
  if (foundStructuredData) {
    // Add emails
    for (const email of extractedEmails) {
      if (!contact.emails.includes(email)) {
        contact.emails.push(email);
      }
    }

    // Add phones
    for (const phone of extractedPhones) {
      const normalized = normalizePhoneForNote(phone);
      if (normalized && !contact.phones.includes(normalized)) {
        contact.phones.push(normalized);
      }
    }

    // Add URLs
    for (const url of extractedUrls) {
      if (!contact.urls.includes(url)) {
        contact.urls.push(url);
      }
    }

    // Add organizations
    for (const org of extractedOrgs) {
      if (!contact.org.includes(org)) {
        contact.org.push(org);
      }
    }

    // Add title if missing
    if (extractedTitle && !contact.title) {
      contact.title = extractedTitle;
    }

    // Update name if we extracted one and current is missing/incomplete
    if ((extractedFirstName || extractedLastName) && !contact.n) {
      contact.n = {
        familyName: extractedLastName,
        givenName: extractedFirstName,
        additionalNames: '',
        honorificPrefixes: '',
        honorificSuffixes: '',
      };
    }
    if (extractedFirstName && contact.n && !contact.n.givenName) {
      contact.n.givenName = extractedFirstName;
    }
    if (extractedLastName && contact.n && !contact.n.familyName) {
      contact.n.familyName = extractedLastName;
    }

    // Update note - keep only non-structured lines, or clear if all was structured
    if (remainingLines.length > 0) {
      contact.note = remainingLines.join('\n');
    } else {
      contact.note = '';
    }
  }
}

// Helper for note parsing (before normalizePhone is defined)
function normalizePhoneForNote(phone: string): string {
  let normalized = phone.trim();
  const hasPlus = normalized.startsWith('+');
  normalized = normalized.replace(/\D/g, '');
  if (normalized.length < 7) return '';
  if (hasPlus) {
    normalized = '+' + normalized;
  }
  return normalized;
}

// ============================================================================
// Normalization Helpers
// ============================================================================

function normalizePhone(phone: string): string {
  // Remove all non-digit characters except leading +
  let normalized = phone.trim();
  const hasPlus = normalized.startsWith('+');
  normalized = normalized.replace(/\D/g, '');

  if (normalized.length < 7) return '';

  // Re-add plus for international numbers
  if (hasPlus) {
    normalized = '+' + normalized;
  }

  return normalized;
}

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

// ============================================================================
// Contact Filtering
// ============================================================================

interface FilterResult {
  keep: boolean;
  reason: string;
}

function shouldFilterContact(contact: Contact): FilterResult {
  const fn = contact.fn.trim();
  const hasPhone = contact.phones.length > 0;
  const hasEmail = contact.emails.length > 0;
  const hasOrg = contact.org.length > 0 && contact.org.some(o => o.trim().length > 0);
  const hasUrl = contact.urls.length > 0;
  const hasAddress = contact.addresses.length > 0 && contact.addresses.some(a =>
    a.streetAddress || a.locality || a.region || a.postalCode || a.countryName);
  const hasTitle = !!contact.title.trim();
  const hasNote = !!contact.note.trim();
  const hasPhoto = !!contact.photo;
  const hasBday = !!contact.bday;

  // Check for first/last name
  const hasFirstName = contact.n?.givenName?.trim();
  const hasLastName = contact.n?.familyName?.trim();
  const hasFullName = hasFirstName && hasLastName;
  const hasSingleNameOnly = (hasFirstName || hasLastName) && !hasFullName;

  // Check for Telegram label (always keep these)
  const hasTelegram = Array.from(contact.otherProperties.entries()).some(([key, values]) =>
    key.includes('LABEL') && values.some(v => v.toLowerCase().includes('telegram'))
  );
  if (hasTelegram) {
    return { keep: true, reason: '' };
  }

  // Rule 1: No name at all
  if (!fn) {
    return { keep: false, reason: 'No name (FN empty)' };
  }

  // Rule 1b: Name is an email address
  if (fn.includes('@') && fn.includes('.')) {
    return { keep: false, reason: `Email as name: '${fn.slice(0, 40)}'` };
  }

  // Rule 1c: Name contains mangled/garbage characters (backslash, braces, brackets)
  // Note: pipe | is allowed (used for "Name | Company" format)
  if (/\\/.test(fn) || /[{}[\]<>]/.test(fn)) {
    return { keep: false, reason: `Mangled/garbage name: '${fn.slice(0, 40)}'` };
  }

  // Rule 1d: Name contains quotes (usually address data parsed as name)
  if (fn.includes('"')) {
    return { keep: false, reason: `Quotes in name (address data): '${fn.slice(0, 40)}'` };
  }

  // Rule 1d: Name is too long (likely garbage data)
  if (fn.length > 50) {
    return { keep: false, reason: `Name too long (${fn.length} chars)` };
  }

  // Rule 1e: Name looks like a phone number
  const fnDigitsOnly = fn.replace(/[\s\-\.\(\)\+]/g, '');
  if (/^\d{7,}$/.test(fnDigitsOnly)) {
    return { keep: false, reason: `Phone number as name: '${fn}'` };
  }

  // Rule 1f: Gibberish/random alphanumeric name (e.g., "D7k5wt3q46")
  if (/^[a-zA-Z0-9]+$/.test(fn) && /\d/.test(fn) && /[a-zA-Z]/.test(fn) && !fn.includes(' ')) {
    // Exclude likely usernames with just trailing numbers (e.g., "john123")
    const isLikelyUsername = /^[a-zA-Z]+\d{1,4}$/.test(fn);
    if (!isLikelyUsername) {
      return { keep: false, reason: `Gibberish name: '${fn}'` };
    }
  }

  // Rule 1g: Very short name (<=3 chars) without phone number
  if (fn.length > 0 && fn.length <= 3 && !hasPhone) {
    return { keep: false, reason: `Very short name (${fn.length} chars): '${fn}'` };
  }

  // Rule 1h: Lowercase single word name without phone (likely username/handle)
  if (/^[a-z]/.test(fn) && !fn.includes(' ') && !hasPhone) {
    return { keep: false, reason: `Lowercase single word: '${fn}'` };
  }

  // Rule 1i: Name is just initials (2+ words, each <=2 chars)
  const nameWords = fn.split(/\s+/);
  if (nameWords.length >= 2 && nameWords.every(w => w.length <= 2)) {
    return { keep: false, reason: `Initials only: '${fn}'` };
  }

  // Rule 1j: Name has parenthetical number (often age/metadata)
  if (/\(\d+\)/.test(fn)) {
    return { keep: false, reason: `Parenthetical number in name: '${fn}'` };
  }

  // Rule 1k: Name ends with domain TLD (e.g., "Guru.com")
  if (/\.(com|org|net|io|co|uk|de|nl)$/i.test(fn)) {
    return { keep: false, reason: `Name ends with TLD: '${fn}'` };
  }

  // Rule 2: Check for metadata garbage prefixes
  const garbagePrefixes = [
    'Work:', 'Home:', 'Email:', 'E-mail', 'Organization:',
    'Note:', 'Home Page:', 'First Name:', 'Research',
    'SOURCE:', 'US-"', 'android-', 'Normal', 'My Contacts'
  ];
  for (const prefix of garbagePrefixes) {
    if (fn.startsWith(prefix)) {
      return { keep: false, reason: `Metadata garbage: starts with '${prefix}'` };
    }
  }

  // Rule 3: Common generic names
  const commonNames = [
    'help', 'hello', 'admin', 'support', 'info', 'contact', 'service',
    'team', 'sales', 'marketing', 'noreply', 'no-reply', 'donotreply',
    'test', 'demo', 'example', 'sample', 'default', 'user', 'guest',
    'anonymous', 'unknown', 'temp', 'temporary'
  ];
  const fullNameLower = fn.toLowerCase();
  const firstNameLower = (hasFirstName || '').toLowerCase();
  const lastNameLower = (hasLastName || '').toLowerCase();

  if (commonNames.includes(fullNameLower) ||
      commonNames.includes(firstNameLower) ||
      commonNames.includes(lastNameLower)) {
    return { keep: false, reason: `Generic name: '${fn}'` };
  }

  // Rule 3b: Short single-word name with only email (no phone) - low quality
  // Catches entries like "ags" with just an email
  const fnWords = fn.split(/\s+/).filter(w => w.length > 0);
  const isSingleWord = fnWords.length === 1;
  const isShortName = fn.length <= 6;
  const hasOnlyEmail = hasEmail && !hasPhone && !hasOrg && !hasTitle && !hasAddress && !hasBday;

  if (isSingleWord && isShortName && hasOnlyEmail && !hasFullName) {
    return { keep: false, reason: `Short single name '${fn}' with only email` };
  }

  // Rule 3c: Single word name (no last name) with only email - likely low quality
  if (isSingleWord && !hasFullName && hasOnlyEmail && !hasUrl) {
    return { keep: false, reason: `Single word name '${fn}' with only email` };
  }

  // Rule 4: First name equals last name (single word duplicated)
  if (hasFirstName && hasLastName) {
    const first = hasFirstName.trim().toLowerCase();
    const last = hasLastName.trim().toLowerCase();
    if (first === last && !first.includes(' ')) {
      return { keep: false, reason: `Duplicate name: '${first}' = '${last}'` };
    }
  }

  // Rule 5: Only has name, nothing else
  const hasOnlyName = !hasPhone && !hasEmail && !hasUrl && !hasAddress &&
                       !hasOrg && !hasTitle && !hasNote && !hasPhoto && !hasBday;
  if (hasOnlyName) {
    return { keep: false, reason: 'Only has name, no contact info' };
  }

  // Rule 6: URL-only contacts (no phone or email)
  if (hasUrl && !hasPhone && !hasEmail) {
    // Allow if they have organization info
    if (!hasOrg && !hasTitle) {
      return { keep: false, reason: 'URL-only, no phone/email' };
    }
  }

  // Rule 7: LinkedIn-only contacts without other meaningful info
  const hasOnlyLinkedIn = contact.urls.length > 0 &&
    contact.urls.every(u => u.includes('linkedin'));
  if (hasOnlyLinkedIn && !hasPhone && !hasEmail && !hasOrg && !hasTitle) {
    return { keep: false, reason: 'LinkedIn URL only, no contact info' };
  }

  // Rule 8: Corporate domain emails - require phone to keep
  // These are typically old LinkedIn imports or one-time email contacts
  const corporateDomains = [
    '@google.com', '@twitter.com', '@x.com', '@googlegroups.com',
    '@facebook.com', '@meta.com', '@microsoft.com', '@amazon.com',
    '@apple.com', '@netflix.com', '@uber.com', '@airbnb.com',
    '@linkedin.com', '@salesforce.com', '@oracle.com'
  ];
  if (hasEmail) {
    const hasCorporateEmail = contact.emails.some(email =>
      corporateDomains.some(d => email.endsWith(d))
    );

    if (hasCorporateEmail && !hasPhone) {
      // Corporate email without phone = low value contact (old LinkedIn, one-time email)
      const corpEmail = contact.emails.find(e => corporateDomains.some(d => e.endsWith(d)));
      return { keep: false, reason: `Corporate email (${corpEmail}) without phone` };
    }
  }

  // Rule 9: Service/notification emails
  const servicePatterns = [
    'noreply', 'no-reply', 'donotreply', 'notification', 'alert',
    'info@', 'support@', 'admin@', 'webmaster@', 'newsletter',
    'updates@', 'news@', 'mailer@', 'daemon@', 'postmaster@'
  ];
  if (hasEmail && contact.emails.every(email => {
    const localPart = email.split('@')[0].toLowerCase();
    return servicePatterns.some(p => localPart.includes(p) || email.toLowerCase().includes(p));
  })) {
    if (!hasPhone && hasSingleNameOnly) {
      return { keep: false, reason: 'Service email only with single name' };
    }
  }

  // Rule 10: No name and no organization
  if (!fn && !hasOrg) {
    return { keep: false, reason: 'No name and no organization' };
  }

  return { keep: true, reason: '' };
}

// ============================================================================
// Deduplication
// ============================================================================

function createContactKey(contact: Contact): string {
  // Create a normalized key for finding potential duplicates
  const normalizedName = contact.fn.toLowerCase().replace(/[^a-z0-9]/g, '');
  const primaryEmail = contact.emails[0] || '';
  const primaryPhone = contact.phones[0] || '';

  return `${normalizedName}|${primaryEmail}|${primaryPhone}`;
}

function normalizeNameForComparison(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '') // Remove non-letters except spaces
    .replace(/\s+/g, ' ')     // Normalize whitespace
    .trim();
}

function areContactsDuplicates(a: Contact, b: Contact): boolean {
  // Strong match: same email
  const sharedEmails = a.emails.filter(e => b.emails.includes(e));
  if (sharedEmails.length > 0) {
    return true;
  }

  // Strong match: same phone
  const sharedPhones = a.phones.filter(p => b.phones.includes(p));
  if (sharedPhones.length > 0) {
    return true;
  }

  // Full name match - but only if both have meaningful full names
  // This catches cases like "Shira Abel" appearing twice with different contact info
  const aName = normalizeNameForComparison(a.fn);
  const bName = normalizeNameForComparison(b.fn);

  // Require at least 2 words in the name to avoid matching "John" to "John"
  const aWords = aName.split(' ').filter(w => w.length > 0);
  const bWords = bName.split(' ').filter(w => w.length > 0);

  if (aWords.length >= 2 && bWords.length >= 2 && aName === bName) {
    return true;
  }

  // Also check structured names (N field) for better matching
  if (a.n && b.n) {
    const aFirst = normalizeNameForComparison(a.n.givenName || '');
    const aLast = normalizeNameForComparison(a.n.familyName || '');
    const bFirst = normalizeNameForComparison(b.n.givenName || '');
    const bLast = normalizeNameForComparison(b.n.familyName || '');

    // Both have first AND last name, and they match
    if (aFirst && aLast && bFirst && bLast &&
        aFirst === bFirst && aLast === bLast) {
      return true;
    }
  }

  return false;
}

function mergeContacts(primary: Contact, secondary: Contact): Contact {
  // Merge secondary into primary, preferring primary's data when both have values
  const merged: Contact = { ...primary };

  // Merge emails
  for (const email of secondary.emails) {
    if (!merged.emails.includes(email)) {
      merged.emails.push(email);
    }
  }

  // Merge phones
  for (const phone of secondary.phones) {
    if (!merged.phones.includes(phone)) {
      merged.phones.push(phone);
    }
  }

  // Merge URLs
  for (const url of secondary.urls) {
    if (!merged.urls.includes(url)) {
      merged.urls.push(url);
    }
  }

  // Merge organizations
  for (const org of secondary.org) {
    if (!merged.org.includes(org)) {
      merged.org.push(org);
    }
  }

  // Merge addresses
  for (const addr of secondary.addresses) {
    const exists = merged.addresses.some(a =>
      a.streetAddress === addr.streetAddress &&
      a.locality === addr.locality &&
      a.postalCode === addr.postalCode
    );
    if (!exists) {
      merged.addresses.push(addr);
    }
  }

  // Use the more complete name
  if (!merged.n && secondary.n) {
    merged.n = secondary.n;
  } else if (merged.n && secondary.n) {
    if (!merged.n.givenName && secondary.n.givenName) {
      merged.n.givenName = secondary.n.givenName;
    }
    if (!merged.n.familyName && secondary.n.familyName) {
      merged.n.familyName = secondary.n.familyName;
    }
  }

  // Use the longer/more complete FN
  if (secondary.fn.length > merged.fn.length) {
    merged.fn = secondary.fn;
  }

  // Merge other fields if primary is empty
  if (!merged.title && secondary.title) merged.title = secondary.title;
  if (!merged.note && secondary.note) merged.note = secondary.note;
  if (!merged.photo && secondary.photo) merged.photo = secondary.photo;
  if (!merged.bday && secondary.bday) merged.bday = secondary.bday;

  // Merge other properties
  for (const [key, values] of secondary.otherProperties) {
    if (!merged.otherProperties.has(key)) {
      merged.otherProperties.set(key, values);
    }
  }

  return merged;
}

function deduplicateContacts(contacts: Contact[]): { deduplicated: Contact[]; mergeCount: number } {
  const result: Contact[] = [];
  const processed = new Set<number>();
  let mergeCount = 0;

  for (let i = 0; i < contacts.length; i++) {
    if (processed.has(i)) continue;

    let current = contacts[i];
    processed.add(i);

    // Find all duplicates
    for (let j = i + 1; j < contacts.length; j++) {
      if (processed.has(j)) continue;

      if (areContactsDuplicates(current, contacts[j])) {
        current = mergeContacts(current, contacts[j]);
        processed.add(j);
        mergeCount++;
      }
    }

    result.push(current);
  }

  return { deduplicated: result, mergeCount };
}

// ============================================================================
// VCF Writer
// ============================================================================

function escapeVCardValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function foldLine(line: string): string {
  if (line.length <= 75) return line;

  const folded: string[] = [];
  let remaining = line;

  folded.push(remaining.substring(0, 75));
  remaining = remaining.substring(75);

  while (remaining.length > 74) {
    folded.push(' ' + remaining.substring(0, 74));
    remaining = remaining.substring(74);
  }

  if (remaining.length > 0) {
    folded.push(' ' + remaining);
  }

  return folded.join('\r\n');
}

function contactToVCard(contact: Contact, format: 'google' | 'apple'): string {
  const lines: string[] = ['BEGIN:VCARD', 'VERSION:3.0'];

  // Add PRODID for Apple
  if (format === 'apple') {
    lines.push('PRODID:-//Apple Inc.//macOS 15.5//EN');
  }

  // UID
  lines.push(foldLine(`UID:${contact.id}`));

  // FN (required)
  const fn = contact.fn || 'Unknown Contact';
  lines.push(foldLine(`FN:${escapeVCardValue(fn)}`));

  // N
  if (contact.n) {
    const nValue = [
      contact.n.familyName || '',
      contact.n.givenName || '',
      contact.n.additionalNames || '',
      contact.n.honorificPrefixes || '',
      contact.n.honorificSuffixes || '',
    ].join(';');
    lines.push(foldLine(`N:${nValue}`));
  } else {
    // Generate N from FN
    const nameParts = fn.split(/\s+/).filter(p => p);
    if (nameParts.length >= 2) {
      const lastName = nameParts[nameParts.length - 1];
      const firstName = nameParts[0];
      const middleNames = nameParts.slice(1, -1).join(' ');
      lines.push(foldLine(`N:${lastName};${firstName};${middleNames};;`));
    } else {
      lines.push(foldLine(`N:${fn};;;;`));
    }
  }

  // Emails
  for (const email of contact.emails) {
    lines.push(foldLine(`EMAIL;TYPE=INTERNET:${email}`));
  }

  // Phones
  for (const phone of contact.phones) {
    lines.push(foldLine(`TEL:${phone}`));
  }

  // URLs
  for (const url of contact.urls) {
    lines.push(foldLine(`URL:${url}`));
  }

  // Organization
  if (contact.org.length > 0) {
    lines.push(foldLine(`ORG:${contact.org.join(';')}`));
  }

  // Title
  if (contact.title) {
    lines.push(foldLine(`TITLE:${escapeVCardValue(contact.title)}`));
  }

  // Note
  if (contact.note) {
    lines.push(foldLine(`NOTE:${escapeVCardValue(contact.note)}`));
  }

  // Birthday
  if (contact.bday) {
    lines.push(foldLine(`BDAY:${contact.bday}`));
  }

  // Addresses
  for (const addr of contact.addresses) {
    const typeStr = addr.type.length > 0 ? `;TYPE=${addr.type.join(',')}` : '';
    const adrValue = [
      addr.poBox,
      addr.extendedAddress,
      addr.streetAddress,
      addr.locality,
      addr.region,
      addr.postalCode,
      addr.countryName,
    ].join(';');
    lines.push(foldLine(`ADR${typeStr}:${adrValue}`));
  }

  // Photo (skip for Google as it can cause import issues)
  if (format === 'apple' && contact.photo) {
    lines.push(foldLine(`PHOTO:${contact.photo}`));
  }

  // Other properties (Apple only, skip X-AB* for Google)
  if (format === 'apple') {
    for (const [key, values] of contact.otherProperties) {
      for (const value of values) {
        // Keep the original line format
        lines.push(foldLine(value));
      }
    }
  }

  lines.push('END:VCARD');
  return lines.join('\r\n');
}

function contactsToVCF(contacts: Contact[], format: 'google' | 'apple'): string {
  return contacts.map(c => contactToVCard(c, format)).join('\r\n') + '\r\n';
}

// ============================================================================
// Main Processing
// ============================================================================

function main() {
  const stats: ProcessingStats = {
    googleTotal: 0,
    appleTotal: 0,
    combinedTotal: 0,
    filteredOut: 0,
    duplicatesMerged: 0,
    finalCount: 0,
    filterReasons: new Map(),
  };

  console.log('='.repeat(60));
  console.log('Contact Processing Script');
  console.log('='.repeat(60));
  console.log('');

  // Read input files
  const publicDir = path.join(process.cwd(), 'public');

  const googleFile = path.join(publicDir, 'google_contacts.vcf');
  const appleFile = path.join(publicDir, 'apple_contacts.vcf');

  let googleContacts: Contact[] = [];
  let appleContacts: Contact[] = [];

  if (fs.existsSync(googleFile)) {
    console.log('Reading Google contacts...');
    const googleContent = fs.readFileSync(googleFile, 'utf-8');
    googleContacts = parseVCFFile(googleContent, 'google');
    stats.googleTotal = googleContacts.length;
    console.log(`  Found ${googleContacts.length} contacts`);
  } else {
    console.log('Google contacts file not found (public/google_contacts.vcf)');
  }

  if (fs.existsSync(appleFile)) {
    console.log('Reading Apple contacts...');
    const appleContent = fs.readFileSync(appleFile, 'utf-8');
    appleContacts = parseVCFFile(appleContent, 'apple');
    stats.appleTotal = appleContacts.length;
    console.log(`  Found ${appleContacts.length} contacts`);
  } else {
    console.log('Apple contacts file not found (public/apple_contacts.vcf)');
  }

  if (googleContacts.length === 0 && appleContacts.length === 0) {
    console.log('\nNo contacts found. Please add VCF files to the public folder.');
    process.exit(1);
  }

  // Combine contacts
  console.log('\nCombining contacts...');
  const allContacts = [...googleContacts, ...appleContacts];
  stats.combinedTotal = allContacts.length;
  console.log(`  Combined total: ${allContacts.length} contacts`);

  // Filter contacts
  console.log('\nFiltering contacts...');
  const keptContacts: Contact[] = [];
  const removedContacts: { contact: Contact; reason: string }[] = [];

  for (const contact of allContacts) {
    const result = shouldFilterContact(contact);
    if (result.keep) {
      keptContacts.push(contact);
    } else {
      removedContacts.push({ contact, reason: result.reason });
      const count = stats.filterReasons.get(result.reason) || 0;
      stats.filterReasons.set(result.reason, count + 1);
    }
  }

  stats.filteredOut = removedContacts.length;
  console.log(`  Kept: ${keptContacts.length}`);
  console.log(`  Filtered out: ${removedContacts.length}`);

  // Deduplicate contacts
  console.log('\nDeduplicating contacts...');
  const { deduplicated, mergeCount } = deduplicateContacts(keptContacts);
  stats.duplicatesMerged = mergeCount;
  stats.finalCount = deduplicated.length;
  console.log(`  Merged ${mergeCount} duplicate entries`);
  console.log(`  Final count: ${deduplicated.length} unique contacts`);

  // Write output files
  const dateStr = new Date().toISOString().split('T')[0];

  console.log('\nWriting output files...');

  const googleOutput = path.join(publicDir, `cleaned-google-contacts-${dateStr}.vcf`);
  const googleVCF = contactsToVCF(deduplicated, 'google');
  fs.writeFileSync(googleOutput, googleVCF, 'utf-8');
  console.log(`  Google format: ${googleOutput}`);

  const appleOutput = path.join(publicDir, `cleaned-apple-contacts-${dateStr}.vcf`);
  const appleVCF = contactsToVCF(deduplicated, 'apple');
  fs.writeFileSync(appleOutput, appleVCF, 'utf-8');
  console.log(`  Apple format: ${appleOutput}`);

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`Google contacts read:    ${stats.googleTotal}`);
  console.log(`Apple contacts read:     ${stats.appleTotal}`);
  console.log(`Combined total:          ${stats.combinedTotal}`);
  console.log(`Filtered out:            ${stats.filteredOut}`);
  console.log(`Duplicates merged:       ${stats.duplicatesMerged}`);
  console.log(`Final unique contacts:   ${stats.finalCount}`);

  if (stats.filterReasons.size > 0) {
    console.log('\nFilter reasons:');
    const sortedReasons = Array.from(stats.filterReasons.entries())
      .sort((a, b) => b[1] - a[1]);
    for (const [reason, count] of sortedReasons) {
      console.log(`  ${count.toString().padStart(5)} - ${reason}`);
    }
  }

  // Print some removed contacts for review
  if (removedContacts.length > 0) {
    console.log('\nSample of removed contacts (first 20):');
    console.log('-'.repeat(60));
    for (const { contact, reason } of removedContacts.slice(0, 20)) {
      const emailStr = contact.emails.length > 0 ? ` <${contact.emails[0]}>` : '';
      const phoneStr = contact.phones.length > 0 ? ` (${contact.phones[0]})` : '';
      console.log(`  ${contact.fn || '(no name)'}${emailStr}${phoneStr}`);
      console.log(`    Reason: ${reason}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('Done!');
  console.log('='.repeat(60));
}

// Run the script
main();
