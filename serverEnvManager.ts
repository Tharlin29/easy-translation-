import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { updateProxyKeys } from './serverProxy';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ENV_FILE_PATH = path.resolve(__dirname, '.env');

export interface EnvEntry {
  key: string;
  value: string;
  maskedValue: string;
  provider: 'gemini' | 'groq' | 'openrouter' | 'deepseek' | 'custom';
  isCommonKey: boolean;
}

export function maskApiKey(k: string): string {
  if (!k) return '(မရှိပါ / Empty)';
  if (k.length <= 8) return '****';
  return k.slice(0, 4) + '...' + k.slice(-4);
}

export function detectProviderFromKey(key: string): 'gemini' | 'groq' | 'openrouter' | 'deepseek' | 'custom' {
  const upper = key.toUpperCase();
  if (upper.includes('GEMINI')) return 'gemini';
  if (upper.includes('GROQ')) return 'groq';
  if (upper.includes('OPENROUTER')) return 'openrouter';
  if (upper.includes('DEEPSEEK')) return 'deepseek';
  return 'custom';
}

/**
 * Reads all key-value entries from .env file
 */
export function readEnvEntries(): EnvEntry[] {
  try {
    if (!fs.existsSync(ENV_FILE_PATH)) {
      // Create empty if missing
      fs.writeFileSync(ENV_FILE_PATH, '# Server Environment Secrets\n', 'utf-8');
      return [];
    }

    const content = fs.readFileSync(ENV_FILE_PATH, 'utf-8');
    const lines = content.split(/\r?\n/);
    const entries: EnvEntry[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const equalIndex = trimmed.indexOf('=');
      if (equalIndex <= 0) continue;

      const key = trimmed.slice(0, equalIndex).trim();
      let value = trimmed.slice(equalIndex + 1).trim();

      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      const provider = detectProviderFromKey(key);
      const isCommonKey = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'APP_URL'].includes(key);

      entries.push({
        key,
        value,
        maskedValue: maskApiKey(value),
        provider,
        isCommonKey,
      });
    }

    return entries;
  } catch (error) {
    console.error('[EnvManager] Error reading .env file:', error);
    return [];
  }
}

/**
 * Returns raw content of .env file
 */
export function getRawEnvContent(): string {
  try {
    if (fs.existsSync(ENV_FILE_PATH)) {
      return fs.readFileSync(ENV_FILE_PATH, 'utf-8');
    }
  } catch (error) {
    console.error('[EnvManager] Error reading raw .env:', error);
  }
  return '';
}

/**
 * Saves a single key-value into .env (Add or Update)
 */
export function saveEnvEntry(key: string, value: string): { success: boolean; entries: EnvEntry[]; error?: string } {
  const cleanKey = key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!cleanKey) {
    return { success: false, entries: readEnvEntries(), error: 'Key အမည် မမှန်ကန်ပါ' };
  }

  const cleanVal = (value || '').trim();

  try {
    let content = '';
    if (fs.existsSync(ENV_FILE_PATH)) {
      content = fs.readFileSync(ENV_FILE_PATH, 'utf-8');
    }

    const lines = content.split(/\r?\n/);
    let keyUpdated = false;
    const newLines: string[] = [];

    const keyRegex = new RegExp(`^\\s*${cleanKey}\\s*=`);

    for (const line of lines) {
      if (keyRegex.test(line)) {
        newLines.push(`${cleanKey}="${cleanVal}"`);
        keyUpdated = true;
      } else {
        newLines.push(line);
      }
    }

    if (!keyUpdated) {
      // Append key at end
      if (newLines.length > 0 && newLines[newLines.length - 1].trim() !== '') {
        newLines.push('');
      }
      newLines.push(`${cleanKey}="${cleanVal}"`);
    }

    fs.writeFileSync(ENV_FILE_PATH, newLines.join('\n'), 'utf-8');

    // Update in-memory process.env immediately
    process.env[cleanKey] = cleanVal;

    // Sync to proxy config if it matches known provider keys
    syncEnvToProxy(cleanKey, cleanVal);

    return {
      success: true,
      entries: readEnvEntries(),
    };
  } catch (error: any) {
    console.error('[EnvManager] Error saving to .env:', error);
    return {
      success: false,
      entries: readEnvEntries(),
      error: error?.message || 'Failed to save to .env file',
    };
  }
}

/**
 * Deletes a key from .env file
 */
export function deleteEnvEntry(key: string): { success: boolean; entries: EnvEntry[]; error?: string } {
  const cleanKey = key.trim();
  if (!cleanKey) {
    return { success: false, entries: readEnvEntries(), error: 'Key အမည် မရှိပါ' };
  }

  try {
    if (!fs.existsSync(ENV_FILE_PATH)) {
      return { success: true, entries: [] };
    }

    const content = fs.readFileSync(ENV_FILE_PATH, 'utf-8');
    const lines = content.split(/\r?\n/);
    const keyRegex = new RegExp(`^\\s*${cleanKey}\\s*=`);

    const newLines = lines.filter((line) => !keyRegex.test(line));

    fs.writeFileSync(ENV_FILE_PATH, newLines.join('\n'), 'utf-8');

    // Remove from in-memory process.env
    delete process.env[cleanKey];

    // Clear in proxy if matched
    syncEnvToProxy(cleanKey, '');

    return {
      success: true,
      entries: readEnvEntries(),
    };
  } catch (error: any) {
    console.error('[EnvManager] Error deleting key from .env:', error);
    return {
      success: false,
      entries: readEnvEntries(),
      error: error?.message || 'Failed to delete key from .env file',
    };
  }
}

/**
 * Overwrites entire .env file with raw text
 */
export function saveRawEnvContent(rawText: string): { success: boolean; entries: EnvEntry[]; error?: string } {
  try {
    fs.writeFileSync(ENV_FILE_PATH, rawText, 'utf-8');

    // Reload dotenv
    const parsed = dotenv.parse(rawText);
    for (const [k, v] of Object.entries(parsed)) {
      process.env[k] = v;
      syncEnvToProxy(k, v);
    }

    return {
      success: true,
      entries: readEnvEntries(),
    };
  } catch (error: any) {
    console.error('[EnvManager] Error saving raw .env:', error);
    return {
      success: false,
      entries: readEnvEntries(),
      error: error?.message || 'Failed to write raw .env content',
    };
  }
}

function syncEnvToProxy(key: string, val: string) {
  try {
    const upper = key.toUpperCase();
    if (upper === 'GROQ_API_KEY') {
      updateProxyKeys({ groqApiKey: val });
    } else if (upper === 'OPENROUTER_API_KEY') {
      updateProxyKeys({ openRouterApiKey: val });
    } else if (upper === 'DEEPSEEK_API_KEY') {
      updateProxyKeys({ deepSeekApiKey: val });
    }
  } catch (err) {
    console.warn('[EnvManager] syncEnvToProxy warning:', err);
  }
}
