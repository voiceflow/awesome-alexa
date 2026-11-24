#!/usr/bin/env node
/* oxlint-disable no-console */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { branchEnvironment, currentBranch, readConfig } from './vfa-config.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

const usage = () => {
  console.log(`Usage: yarn vfa:apply --project <id> --name <name> [options]

Send every document of the input directory to the import API. The server diffs them against the origin through the
lock it stores for the environment, applies the changes in a working environment, publishes it, merges it back
into the origin and removes it. The merge puts the origin's draft live. With no stored lock, every resource is
deleted and recreated with a new ID. When nothing differs, no environment is created.

Options:
  --project <id>       Project ID (default: spec.projectID in voiceflow.yaml)
  --in <directory>     Directory to read (default: ./voiceflow)
  --name <name>        Name of the working environment and its release (required)
  --env <alias>        Origin environment alias (default: the current branch's alias in voiceflow.yaml;
                       a branch voiceflow.yaml doesn't map applies nothing)
  --ref <ref>          Git ref to read; omitted means the working tree
  --commit <sha>       Git commit to record against the version the import puts live; an environment that
                       already holds it, pushed from Voiceflow or applied before, applies nothing
  --api <url>          API base URL (default: VFA_API_URL, then spec.api.url in voiceflow.yaml)
  --token <token>      API bearer token (default: VFA_TOKEN)
  -h, --help           Show this help`);
};

const main = async () => {
  // Variables already set in the shell take precedence over .env.local
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  const config = readConfig();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: 'string', default: config.projectID },
      in: { type: 'string', default: './voiceflow' },
      name: { type: 'string' },
      env: { type: 'string' },
      ref: { type: 'string' },
      commit: { type: 'string' },
      api: { type: 'string', default: process.env.VFA_API_URL ?? config.apiURL },
      token: { type: 'string', default: process.env.VFA_TOKEN },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return usage();
  if (positionals.length || !values.in || !values.project || !values.name || !values.api || !values.token) {
    usage();
    process.exit(2);
  }

  // Each environment syncs to its own branch, so a branch voiceflow.yaml doesn't map has nowhere to apply
  values.env ??= branchEnvironment(config);
  if (!values.env) {
    console.log(
      `Branch ${currentBranch() ?? '(detached)'} maps to no environment in voiceflow.yaml. Nothing to apply.`
    );
    return;
  }

  const documentArgs = [path.join(scriptDirectory, 'vfa-documents.mjs'), values.in, '--name', values.name];
  if (values.ref) documentArgs.push('--ref', values.ref);
  console.log(`Reading documents from ${values.in}${values.ref ? ` at ${values.ref}` : ''}...`);
  const requestBody = JSON.parse(execFileSync(process.execPath, documentArgs, { encoding: 'utf8' }));
  if (values.commit) requestBody.commit = values.commit;

  const kindCounts = new Map();
  for (const { kind } of requestBody.documents) kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  console.log(
    `Read ${requestBody.documents.length} documents: ${[...kindCounts].map(([kind, count]) => `${count} ${kind}`).join(', ')}.`
  );

  const endpoint = new URL('/v1/stable/vfa/import', values.api);
  endpoint.searchParams.set('projectID', values.project);
  endpoint.searchParams.set('environmentAlias', values.env);
  console.log(`Importing into project ${values.project}, environment ${values.env}, via ${endpoint.origin}`);
  console.log(`Working environment: ${values.name}`);

  // The server diffs, applies, publishes and merges within one request, so report progress while it runs
  const startedAt = Date.now();
  const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
  const heartbeat = setInterval(() => console.log(`Still waiting for the import... (${elapsed()})`), 10_000);
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${values.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
  } finally {
    clearInterval(heartbeat);
  }
  console.log(`Import responded ${response.status} after ${elapsed()}.`);
  if (!response.ok) throw new Error(`VFA import failed (${response.status}): ${await response.text()}`);

  const imported = await response.json();
  if (imported.skipped) {
    console.log(
      `${imported.environment.name} (${imported.environment.alias}) already holds this commit, pushed from Voiceflow or applied before. Nothing to apply.`
    );
    return;
  }
  console.log(
    `Applied ${requestBody.documents.length} documents to ${imported.environment.name} (${imported.environment.alias}).`
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
