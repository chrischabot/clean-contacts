# Clean Contacts

*A surgical instrument for the digital age's most neglected mess: your contact list.*

Over the years, your contacts have accumulated like sediment—business cards from conferences long forgotten, LinkedIn imports of people whose faces you couldn't pick from a crowd, mailing list addresses that somehow sprouted legs and walked into your address book. This tool exists to restore order to that chaos.

## What It Does

Clean Contacts is a TypeScript script that takes the combined exports from Google Contacts and Apple Contacts, merges them into a unified collection, ruthlessly eliminates the debris, intelligently deduplicates entries, and produces pristine VCF files ready for re-import.

The philosophy is simple: **a contact worth keeping has a name you recognize and a way to reach them**. Everything else is noise.

## The Cleaning Process

### 1. Parsing & Repair
The script reads both Google and Apple VCF exports, handling the delightful inconsistencies between formats. It repairs mangled entries—those unfortunate contacts where CSV data has somehow been crammed into name fields, leaving you with entries like `"Smith, John, john@email.com, 555-1234"` as someone's first name.

### 2. Note Field Extraction
Many contacts have structured data hiding in their notes field: phone numbers, emails, job titles laboriously typed in by hand. The script detects these patterns, extracts the data into proper vCard fields, and clears the cruft.

### 3. Intelligent Filtering
This is where the magic happens. The script applies a cascade of filters to identify contacts that have no place in a curated address book:

| Filter | What It Catches |
|--------|-----------------|
| **Empty names** | The ghosts—entries with no name at all |
| **Email-as-name** | When `john@company.com` is listed as someone's name |
| **Mangled data** | Names containing `\`, `{`, `}`, `<`, `>`, or `"` |
| **Excessive length** | Names over 50 characters (usually garbage) |
| **Phone-as-name** | When a phone number masquerades as a name |
| **Gibberish** | Random alphanumeric strings like `D7k5wt3q46` |
| **Too short** | Three-character names without phone numbers |
| **Lowercase handles** | `johndoe` without any phone (likely a username) |
| **Initials only** | `J. D.` with no other identifying information |
| **Metadata debris** | Names starting with `Work:`, `Home:`, `Email:`, etc. |
| **Generic names** | `Support`, `Sales`, `Admin`, `Team`, `Info` |
| **Corporate emails** | `@google.com`, `@twitter.com` without phone numbers |
| **Service addresses** | `noreply@`, `newsletter@`, `notifications@` |
| **Name-only entries** | A name with no email, phone, or any contact method |
| **URL-only entries** | Just a LinkedIn profile, nothing else |
| **Domain names** | When someone named a contact `Guru.com` |

### 4. Deduplication
The script identifies duplicates using strong signals only:

- **Shared email address** → Definite match
- **Shared phone number** → Definite match
- **Identical full name** (first + last) → Match and merge

When duplicates are found, they're merged intelligently: emails combine, phone numbers combine, the more complete name wins, and supplementary data (org, title, birthday) fills in gaps.

### 5. Export
Finally, the unified, cleaned, deduplicated contacts are written to two VCF files—one optimized for Google Contacts import, one for Apple Contacts. The same contacts, formatted for their destination.

## Usage

### Step 1: Export Your Contacts

**From Google Contacts:**
1. Visit [contacts.google.com](https://contacts.google.com)
2. Click *Export* in the left sidebar
3. Select *vCard (for iOS Contacts)*
4. Save as `public/google_contacts.vcf`

**From Apple Contacts:**
1. Open Contacts on macOS
2. Select *All Contacts* (or a specific group)
3. *File* → *Export* → *Export vCard...*
4. Save as `public/apple_contacts.vcf`

### Step 2: Run the Script

```bash
npm install
npm run process
```

### Step 3: Import the Results

Your cleaned contacts await in the `public/` directory:
- `cleaned-google-contacts-YYYY-MM-DD.vcf` → Import to Google Contacts
- `cleaned-apple-contacts-YYYY-MM-DD.vcf` → Import to Apple Contacts

## Sample Output

```
============================================================
Contact Processing Script
============================================================

Reading Google contacts...
  Found 1639 contacts
Reading Apple contacts...
  Found 2733 contacts

Combining contacts...
  Combined total: 4372 contacts

Filtering contacts...
  Kept: 1640
  Filtered out: 2732

Deduplicating contacts...
  Merged 580 duplicate entries
  Final count: 1060 unique contacts

============================================================
Summary
============================================================
Google contacts read:    1639
Apple contacts read:     2733
Combined total:          4372
Filtered out:            2732
Duplicates merged:       580
Final unique contacts:   1060
```

From 4,372 scattered entries down to 1,060 meaningful contacts. The wheat, separated from the chaff.

## Configuration

The filtering rules are defined in `process-contacts.ts`. The code is deliberately readable—modify the `shouldFilterContact()` function to adjust which contacts survive the culling.

Some contacts receive automatic immunity:
- Anyone with a **Telegram** label (these are intentionally added)
- Names containing **emoji** (these are usually personal contacts with nicknames)
- Names with **pipe separators** like `Igor | Hype Talent` (a common professional format)

## Requirements

- Node.js 18+
- TypeScript (via tsx)

## License

MIT. Clean your contacts in peace.

---

*"The art of being wise is the art of knowing what to overlook."* — William James

Your address book should contain people, not the digital detritus of a decade's worth of newsletter signups and forgotten conference contacts. This tool helps you remember who matters.
