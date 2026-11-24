#!/usr/bin/env node
/* oxlint-disable no-console */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { stringify } from 'yaml';

import { branchEnvironment, readConfig } from './vfa-config.mjs';

const usage = () => {
  console.log(`Usage: yarn vfa:export [options]

Export the environment draft as VFA YAML, function code, prompt text, and playbook and agent instruction sidecars.
The server stores the export's key-to-ID lock for the environment, which the next apply diffs against.

Options:
  --project <id>       Project ID (default: spec.projectID in voiceflow.yaml)
  --out <directory>    Directory to write, created if missing (default: ./voiceflow)
  --env <alias>        Environment alias (default: the current branch's alias in voiceflow.yaml, then main)
  --api <url>          API base URL (default: VFA_API_URL, then spec.api.url in voiceflow.yaml)
  --token <token>      API bearer token (default: VFA_TOKEN)
  -h, --help           Show this help`);
};

const safeRelativePath = (value) => {
  if (typeof value !== 'string' || !value || path.posix.isAbsolute(value))
    throw new Error(`invalid export path: ${value}`);
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../'))
    throw new Error(`export path escapes target directory: ${value}`);
  return normalized;
};

const main = async () => {
  // Variables already set in the shell take precedence over .env.local
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  const config = readConfig();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: 'string', default: config.projectID },
      out: { type: 'string', default: './voiceflow' },
      env: { type: 'string', default: branchEnvironment(config) || 'main' },
      api: { type: 'string', default: process.env.VFA_API_URL ?? config.apiURL },
      token: { type: 'string', default: process.env.VFA_TOKEN },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return usage();
  if (positionals.length || !values.project || !values.out || !values.api || !values.token) usage();

  const endpoint = new URL('/v1/stable/vfa/export', values.api);
  endpoint.searchParams.set('projectID', values.project);
  endpoint.searchParams.set('environmentAlias', values.env);
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${values.token}` } });
  if (!response.ok) throw new Error(`VFA export failed (${response.status}): ${await response.text()}`);

  const exported = await response.json();
  if (!Array.isArray(exported.documents)) {
    throw new Error('VFA export response is missing documents');
  }
  const output = path.resolve(values.out);
  await mkdir(output, { recursive: true });

  for (const document of exported.documents) {
    const relative = safeRelativePath(document.path);
    const file = path.join(output, relative);
    await mkdir(path.dirname(file), { recursive: true });
    const { path: _path, ...serializable } = structuredClone(document);
    if (document.kind === 'Function' && typeof document.spec?.code === 'string') {
      const codePath = path.posix.join(path.posix.dirname(relative), 'code.js');
      const codeFile = path.join(output, safeRelativePath(codePath));
      await mkdir(path.dirname(codeFile), { recursive: true });
      await writeFile(codeFile, document.spec.code, 'utf8');
      serializable.spec.code = { file: 'code.js' };
    }
    if (document.kind === 'Prompt' && typeof document.spec?.system === 'string') {
      const systemFile = path.join(
        output,
        safeRelativePath(path.posix.join(path.posix.dirname(relative), 'prompt.md'))
      );
      await writeFile(systemFile, document.spec.system, 'utf8');
      serializable.spec.system = { file: 'prompt.md' };
    }
    if (document.kind === 'Agent' && typeof document.spec?.prompt === 'string') {
      const promptFile = path.join(
        output,
        safeRelativePath(path.posix.join(path.posix.dirname(relative), 'prompt.md'))
      );
      await writeFile(promptFile, document.spec.prompt, 'utf8');
      serializable.spec.prompt = { file: 'prompt.md' };
    }
    if (
      (document.kind === 'Playbook' || document.kind === 'Agent') &&
      typeof document.spec?.instructions === 'string'
    ) {
      const instructionsFile = path.join(
        output,
        safeRelativePath(path.posix.join(path.posix.dirname(relative), 'instructions.md'))
      );
      await writeFile(instructionsFile, document.spec.instructions, 'utf8');
      serializable.spec.instructions = { file: 'instructions.md' };
    }
    await writeFile(file, stringify(serializable), 'utf8');
  }

  console.log(`Exported ${exported.documents.length} VFA documents to ${output}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
