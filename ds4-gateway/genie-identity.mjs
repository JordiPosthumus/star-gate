// Genie's identity files are versioned in genie/ and seeded into the private
// profile exactly once. An owner edit is never overwritten, and an empty file is
// an owner decision rather than a missing one.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const IDENTITY_FILES = Object.freeze(['SOUL.md', 'AGENTS.md']);
const defaults = fileURLToPath(new URL('../genie/', import.meta.url));

export function seedGenieHome(directory, {source = defaults} = {}) {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('A Genie profile directory is required.');
  const home = path.resolve(directory, 'hermes-home');
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  const seeded = [];
  for (const name of IDENTITY_FILES) {
    const destination = path.join(home, name);
    try {
      fs.copyFileSync(path.join(source, name), destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination, 0o600);
      seeded.push(name);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  return {home, seeded};
}

// Read-only view for diagnostics: which identity files exist, and whether they
// still match the versioned default. Content is never returned here.
export function identityStatus(directory, {source = defaults} = {}) {
  const home = path.resolve(directory, 'hermes-home');
  return IDENTITY_FILES.map(name => {
    const file = path.join(home, name);
    let present = false;
    let matchesDefault = false;
    try {
      const content = fs.readFileSync(file, 'utf8');
      present = true;
      matchesDefault = content === fs.readFileSync(path.join(source, name), 'utf8');
    } catch {}
    return {name, present, matchesDefault};
  });
}
