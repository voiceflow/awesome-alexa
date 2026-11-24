#!/usr/bin/env node
/* oxlint-disable no-console */
/**
 * Reads every VFA document of a folder into the request body `POST /v1/stable/vfa/import` accepts.
 *
 *   node scripts/vfa-documents.mjs <folder> [--ref <ref>] [--name <name>]
 *
 * The body is the whole desired state, with sidecars inlined: the server diffs it against the origin
 * through the lock it stores for the environment. `--ref` reads the folder at a git ref; it defaults to
 * the working tree. A key declared twice in one kind is an error. With `--name` the output
 * is the whole request body; otherwise `{ documents }`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { parseAllDocuments } from 'yaml';

const SPEC_FIELDS = ['color', 'description', 'defaultValue'];
const FUNCTION_FIELDS = new Set(['description', 'code', 'inputs', 'outputs', 'paths']);
const API_TOOL_FIELDS = new Set([
  'name',
  'description',
  'httpMethod',
  'url',
  'headers',
  'queryParameters',
  'body',
  'inputs',
]);

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

const readAt = (root, ref, file) => {
  if (ref === null) {
    const absolute = path.join(root, file);

    return existsSync(absolute) ? readFileSync(absolute, 'utf-8') : null;
  }

  try {
    return git(['show', `${ref}:${file}`], root);
  } catch {
    return null;
  }
};

const isVFAYaml = (file) => /\.ya?ml$/.test(file) && !file.split('/').includes('.vfa');

const parseDocuments = (source, file) =>
  parseAllDocuments(source).map((document) => {
    if (document.errors.length) throw new Error(`${file}: ${document.errors[0].message}`);

    return document.toJS();
  });

/** `null` and an absent field mean the same thing, and `x-` keys are never synced. */
const normalizeSpec = (spec, where) => {
  const unknown = Object.keys(spec ?? {}).filter((field) => !SPEC_FIELDS.includes(field) && !field.startsWith('x-'));

  if (unknown.length) throw new Error(`${where}: unknown field ${unknown.join(', ')}`);

  return Object.fromEntries(
    SPEC_FIELDS.filter((field) => spec?.[field] !== null && spec?.[field] !== undefined).map((field) => [
      field,
      String(spec[field]),
    ])
  );
};

const variableListsOf = (source, file) =>
  parseDocuments(source, file).filter(
    (document) => String(document?.version ?? '').startsWith('vfa/') && document.kind === 'VariableList'
  );

const functionDocumentsOf = (source, file) =>
  parseDocuments(source, file).filter(
    (document) => String(document?.version ?? '').startsWith('vfa/') && document.kind === 'Function'
  );

const apiToolDocumentsOf = (source) =>
  parseDocuments(source).filter(
    (document) => String(document?.version ?? '').startsWith('vfa/') && document.kind === 'ApiTool'
  );

/** The text of a `{ file }` sidecar, resolved relative to the YAML file that names it. */
const readSidecar = ({ root, ref, folder, file }, value, field, where) => {
  const sidecar = value?.file;
  if (typeof sidecar !== 'string' || !sidecar) throw new Error(`${where}: ${field}.file must name a sidecar`);
  const sidecarPath = path.posix.normalize(path.posix.join(path.posix.dirname(file), sidecar));
  const relativeToFolder = path.posix.relative(folder, sidecarPath);
  if (relativeToFolder.startsWith('../') || relativeToFolder === '..') {
    throw new Error(`${where}: ${field}.file must stay inside the VFA folder`);
  }
  const text = readAt(root, ref, sidecarPath);
  if (text === null) throw new Error(`${where}: ${field} file ${sidecarPath} not found`);
  return text;
};

const normalizeFunctionSpec = (root, ref, folder, file, spec, key) => {
  const where = `${file} (${ref ?? 'working tree'}) function ${key}`;
  const unknown = Object.keys(spec ?? {}).filter((field) => !FUNCTION_FIELDS.has(field) && !field.startsWith('x-'));
  if (unknown.length) throw new Error(`${where}: unknown field ${unknown.join(', ')}`);
  const code = readSidecar({ root, ref, folder, file }, spec?.code, 'code', where);
  const normalizeMap = (value, field) =>
    Object.fromEntries(
      Object.entries(value ?? {})
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([name, definition]) => {
          const extras = Object.keys(definition ?? {}).filter((key) => key !== 'description' && !key.startsWith('x-'));
          if (extras.length) throw new Error(`${where}: ${field}.${name} has unknown field ${extras.join(', ')}`);
          return [name, definition?.description == null ? {} : { description: String(definition.description) }];
        })
    );
  const paths = (spec?.paths ?? []).map((item, index) => {
    const extras = Object.keys(item ?? {}).filter(
      (field) => !['name', 'label'].includes(field) && !field.startsWith('x-')
    );
    if (extras.length || typeof item?.name !== 'string') throw new Error(`${where}: invalid paths[${index}]`);
    return { name: item.name, ...(item.label == null ? {} : { label: String(item.label) }) };
  });
  return {
    ...(spec?.description == null ? {} : { description: String(spec.description) }),
    code,
    inputs: normalizeMap(spec?.inputs, 'inputs'),
    outputs: normalizeMap(spec?.outputs, 'outputs'),
    paths,
  };
};

const loadFunctions = (root, ref, folder, files) => {
  const functions = new Map();
  for (const file of files) {
    const source = readAt(root, ref, file);
    if (source === null) continue;
    for (const document of functionDocumentsOf(source, file)) {
      const key = document?.metadata?.key;
      if (typeof key !== 'string' || !key) throw new Error(`${file}: Function metadata.key is required`);
      if (functions.has(key))
        throw new Error(
          `${file} (${ref ?? 'working tree'}) function ${key}: also declared in ${functions.get(key).file}`
        );
      functions.set(key, { file, spec: normalizeFunctionSpec(root, ref, folder, file, document.spec, key) });
    }
  }
  return functions;
};

const normalizeApiToolSpec = (spec, where) => {
  const unknown = Object.keys(spec ?? {}).filter((field) => !API_TOOL_FIELDS.has(field) && !field.startsWith('x-'));
  if (unknown.length) throw new Error(`${where}: unknown field ${unknown.join(', ')}`);
  const fields = (value, fieldName) =>
    (value ?? []).map((field, index) => {
      const extras = Object.keys(field ?? {}).filter((key) => !['key', 'value'].includes(key) && !key.startsWith('x-'));
      if (extras.length || typeof field?.key !== 'string') throw new Error(`${where}: invalid ${fieldName}[${index}]`);
      return { key: field.key, value: String(field.value ?? '') };
    });
  const inputs = Object.fromEntries(
    Object.entries(spec?.inputs ?? {})
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, input]) => {
        const extras = Object.keys(input ?? {}).filter((key) => key !== 'description' && !key.startsWith('x-'));
        if (extras.length) throw new Error(`${where}: inputs.${name} has unknown field ${extras.join(', ')}`);
        return [name, input?.description == null ? {} : { description: String(input.description) }];
      })
  );
  let body;
  if (spec?.body?.type === 'raw-input') {
    body = {
      type: 'raw-input',
      content: String(spec.body.content ?? ''),
      ...(spec.body.contentType && { contentType: spec.body.contentType }),
    };
  } else if (spec?.body?.type === 'form-data') {
    body = { type: 'form-data', formData: fields(spec.body.formData, 'body.formData') };
  } else if (spec?.body?.type === 'url-encoded') {
    body = { type: 'url-encoded', params: fields(spec.body.params, 'body.params') };
  } else if (spec?.body != null) throw new Error(`${where}: unsupported body type ${spec.body.type}`);
  const httpMethod = spec?.httpMethod;
  if (!['get', 'put', 'post', 'patch', 'delete'].includes(httpMethod)) {
    throw new Error(`${where}: httpMethod must be get, put, post, patch or delete`);
  }
  return {
    ...(spec?.name == null ? {} : { name: String(spec.name) }),
    ...(spec?.description == null ? {} : { description: String(spec.description) }),
    httpMethod: httpMethod,
    ...(spec?.url === undefined ? {} : { url: spec.url == null ? null : String(spec.url) }),
    headers: fields(spec?.headers, 'headers'),
    queryParameters: fields(spec?.queryParameters, 'queryParameters'),
    ...(body === undefined ? {} : { body }),
    inputs,
  };
};

const TEST_FIELDS = new Set(['name', 'settings', 'turns']);

/** Drops `x-` keys at every depth and sorts object keys, so equal specs serialize equally. */
const stripLoose = (value) => {
  if (Array.isArray(value)) return value.map(stripLoose);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith('x-'))
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stripLoose(entry)])
  );
};

/** Turns and checks keep the stable read shape; the import endpoint validates their payloads. */
const normalizeTestSpec = (spec, where) => {
  const unknown = Object.keys(spec ?? {}).filter((field) => !TEST_FIELDS.has(field) && !field.startsWith('x-'));
  if (unknown.length) throw new Error(`${where}: unknown field ${unknown.join(', ')}`);
  if (!Array.isArray(spec?.turns)) throw new Error(`${where}: turns must be a list`);
  spec.turns.forEach((turn, index) => {
    if (!['user', 'agent', 'simulation'].includes(turn?.type))
      throw new Error(`${where}: invalid turns[${index}].type`);
    if (turn.type === 'agent' && !Array.isArray(turn.checks))
      throw new Error(`${where}: turns[${index}].checks must be a list`);
  });
  return stripLoose({
    ...(spec.name == null ? {} : { name: String(spec.name) }),
    ...(spec.settings == null ? {} : { settings: spec.settings }),
    turns: spec.turns,
  });
};

const loadTests = (root, ref, files) => {
  const tests = new Map();
  for (const file of files) {
    const source = readAt(root, ref, file);
    if (source === null) continue;
    for (const document of parseDocuments(source, file)) {
      if (!String(document?.version ?? '').startsWith('vfa/') || document.kind !== 'Test') continue;
      const key = document?.metadata?.key;
      if (typeof key !== 'string' || !key) throw new Error(`${file}: Test metadata.key is required`);
      const where = `${file} (${ref ?? 'working tree'}) test ${key}`;
      if (tests.has(key)) throw new Error(`${where}: also declared in ${tests.get(key).file}`);
      tests.set(key, { file, spec: normalizeTestSpec(document.spec, where) });
    }
  }
  return tests;
};

const PROMPT_FIELDS = new Set(['name', 'system', 'settings']);

const normalizePromptSpec = (spec, where, source) => {
  const unknown = Object.keys(spec ?? {}).filter((field) => !PROMPT_FIELDS.has(field) && !field.startsWith('x-'));
  if (unknown.length) throw new Error(`${where}: unknown field ${unknown.join(', ')}`);
  const system = readSidecar(source, spec?.system, 'system', where);
  return stripLoose({
    ...(spec.name == null ? {} : { name: String(spec.name) }),
    system,
    ...(spec.settings == null ? {} : { settings: spec.settings }),
  });
};

/** Every document of one kind the files declare, keyed by metadata.key. A key declared twice on one side is an error. */
const loadKind = (kind, label, normalize) => (root, ref, folder, files) => {
  const loaded = new Map();
  for (const file of files) {
    const source = readAt(root, ref, file);
    if (source === null) continue;
    for (const document of parseDocuments(source, file)) {
      if (!String(document?.version ?? '').startsWith('vfa/') || document.kind !== kind) continue;
      const key = document?.metadata?.key;
      if (typeof key !== 'string' || !key) throw new Error(`${file}: ${kind} metadata.key is required`);
      const where = `${file} (${ref ?? 'working tree'}) ${label} ${key}`;
      if (loaded.has(key)) throw new Error(`${where}: also declared in ${loaded.get(key).file}`);
      loaded.set(key, { file, spec: normalize(document.spec, where, { root, ref, folder, file }) });
    }
  }
  return loaded;
};

const loadPrompts = loadKind('Prompt', 'prompt', normalizePromptSpec);

const PLAYBOOK_TOOLS = [
  'endTool',
  'cardTool',
  'buttonTool',
  'carouselTool',
  'skipTurnTool',
  'webSearchTool',
  'callForwardTool',
  'knowledgeBaseTool',
];
const PLAYBOOK_FIELDS = new Set(['name', 'description', 'settings', 'instructions', ...PLAYBOOK_TOOLS]);

/** Native tools keep the stable read shape; the import endpoint validates them. */
const normalizePlaybookSpec = (spec, where, source) => {
  const unknown = Object.keys(spec ?? {}).filter((field) => !PLAYBOOK_FIELDS.has(field) && !field.startsWith('x-'));
  if (unknown.length) throw new Error(`${where}: unknown field ${unknown.join(', ')}`);
  return stripLoose({
    ...(spec.name == null ? {} : { name: String(spec.name) }),
    ...(spec.description == null ? {} : { description: String(spec.description) }),
    ...(spec.settings == null ? {} : { settings: spec.settings }),
    ...(spec.instructions == null
      ? {}
      : { instructions: readSidecar(source, spec.instructions, 'instructions', where) }),
    ...Object.fromEntries(PLAYBOOK_TOOLS.flatMap((tool) => (spec[tool] == null ? [] : [[tool, spec[tool]]]))),
  });
};

const loadPlaybooks = loadKind('Playbook', 'playbook', normalizePlaybookSpec);

const AGENT_FIELDS = new Set(['prompt', 'includeGuidelines', 'instructions', ...PLAYBOOK_TOOLS]);

const normalizeAgentSpec = (spec, where, source) => {
  const unknown = Object.keys(spec ?? {}).filter((field) => !AGENT_FIELDS.has(field) && !field.startsWith('x-'));
  if (unknown.length) throw new Error(`${where}: unknown field ${unknown.join(', ')}`);
  return stripLoose({
    prompt: readSidecar(source, spec.prompt, 'prompt', where),
    ...(spec.includeGuidelines == null ? {} : { includeGuidelines: Boolean(spec.includeGuidelines) }),
    ...(spec.instructions == null
      ? {}
      : { instructions: readSidecar(source, spec.instructions, 'instructions', where) }),
    ...Object.fromEntries(PLAYBOOK_TOOLS.flatMap((tool) => (spec[tool] == null ? [] : [[tool, spec[tool]]]))),
  });
};

const loadAgents = loadKind('Agent', 'agent', normalizeAgentSpec);

const BEHAVIOR_FIELDS = new Set(['llm', 'voice']);

/** Settings keep the stable shape; the import endpoint validates them. */
const normalizeBehaviorSpec = (spec, where) => {
  const unknown = Object.keys(spec ?? {}).filter((field) => !BEHAVIOR_FIELDS.has(field) && !field.startsWith('x-'));
  if (unknown.length) throw new Error(`${where}: unknown field ${unknown.join(', ')}`);
  return stripLoose({
    ...(spec?.llm == null ? {} : { llm: spec.llm }),
    ...(spec?.voice == null ? {} : { voice: spec.voice }),
  });
};

const loadBehaviors = loadKind('AgentBehavior', 'agent behavior', normalizeBehaviorSpec);

const ROUTING_FIELDS = new Set(['playbooks', 'workflows']);

/** Routes name playbooks by document key; the import endpoint resolves them and validates the rest. */
const normalizeRoutingSpec = (spec, where) => {
  const unknown = Object.keys(spec ?? {}).filter((field) => !ROUTING_FIELDS.has(field) && !field.startsWith('x-'));
  if (unknown.length) throw new Error(`${where}: unknown field ${unknown.join(', ')}`);
  ['playbooks', 'workflows'].forEach((field) => {
    if (!Array.isArray(spec?.[field] ?? [])) throw new Error(`${where}: ${field} must be a list`);
  });
  (spec.playbooks ?? []).forEach((route, index) => {
    if (typeof route?.playbook !== 'string' || !route.playbook) {
      throw new Error(`${where}: playbooks[${index}].playbook must name a Playbook key`);
    }
  });
  return stripLoose({ playbooks: spec.playbooks ?? [], workflows: spec.workflows ?? [] });
};

const loadRoutings = loadKind('AgentRouting', 'agent routing', normalizeRoutingSpec);

const loadApiTools = (root, ref, files) => {
  const apiTools = new Map();
  for (const file of files) {
    const source = readAt(root, ref, file);
    if (source === null) continue;
    for (const document of apiToolDocumentsOf(source)) {
      const key = document?.metadata?.key;
      if (typeof key !== 'string' || !key) throw new Error(`${file}: ApiTool metadata.key is required`);
      if (apiTools.has(key))
        throw new Error(
          `${file} (${ref ?? 'working tree'}) API tool ${key}: also declared in ${apiTools.get(key).file}`
        );
      apiTools.set(key, {
        file,
        spec: normalizeApiToolSpec(document.spec, `${file} (${ref ?? 'working tree'}) API tool ${key}`),
      });
    }
  }
  return apiTools;
};

/** Every variable the given files declare, keyed by key. One key declared twice on one side is an error. */
const loadVariables = (root, ref, files) => {
  const variables = new Map();
  const add = (file, key, spec) => {
    const where = `${file} (${ref ?? 'working tree'}) variable ${key}`;

    if (variables.has(key)) throw new Error(`${where}: also declared in ${variables.get(key).file}`);

    variables.set(key, { file, spec: normalizeSpec(spec, where) });
  };

  for (const file of files) {
    const source = readAt(root, ref, file);

    if (source === null) continue;

    variableListsOf(source, file).forEach((document) =>
      Object.entries(document.spec ?? {}).forEach(([key, spec]) => add(file, key, spec))
    );
  }

  return variables;
};

const lines = (output) => output.split('\n').filter(Boolean);

const usage = () => {
  console.log(`Usage: yarn vfa:documents <directory> [options]

Read every variable, function, API tool, test, prompt, playbook, agent, agent behavior and agent routing document
as JSON. Output can be passed to the import API, which diffs it against the environment's stored lock.

Options:
  --ref <ref>        Git ref to read; omitted means the working tree
  --name <name>      Include the working environment name in the request body
  -h, --help         Show this help

Function, prompt, playbook and agent documents resolve spec.code.file, spec.system.file, spec.prompt.file and
spec.instructions.file relative to the YAML file and inline them.`);
};

/** Every VFA yaml file under the folder at a ref, or in the working tree (tracked or not) when ref is null. */
const listFiles = (root, ref, relative) =>
  (ref === null
    ? lines(git(['ls-files', '--cached', '--others', '--exclude-standard', '--', relative], root)).filter((file) =>
        existsSync(path.join(root, file))
      )
    : lines(git(['ls-tree', '-r', '--name-only', ref, '--', relative], root))
  ).filter((file) => isVFAYaml(path.relative(relative, file)));

const VERSION = 'vfa/v1';

const documentsOf = (kind, loaded) =>
  [...loaded].map(([key, { spec }]) => ({ version: VERSION, kind, metadata: { key }, spec }));

const main = () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      ref: { type: 'string' },
      name: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) return usage();

  const [folder] = positionals;

  if (!folder) {
    usage();
    process.exit(2);
  }

  const root = git(['rev-parse', '--show-toplevel'], path.resolve(folder)).trim();
  const relative = path.relative(root, path.resolve(folder)) || '.';
  const ref = values.ref ?? null;
  const files = listFiles(root, ref, relative);
  const variables = loadVariables(root, ref, files);

  const documents = [
    ...(variables.size
      ? [
          {
            version: VERSION,
            kind: 'VariableList',
            metadata: { key: 'variables' },
            spec: Object.fromEntries([...variables].map(([key, { spec }]) => [key, spec])),
          },
        ]
      : []),
    ...documentsOf('Function', loadFunctions(root, ref, relative, files)),
    ...documentsOf('ApiTool', loadApiTools(root, ref, files)),
    ...documentsOf('Test', loadTests(root, ref, files)),
    ...documentsOf('Prompt', loadPrompts(root, ref, relative, files)),
    ...documentsOf('Playbook', loadPlaybooks(root, ref, relative, files)),
    ...documentsOf('Agent', loadAgents(root, ref, relative, files)),
    ...documentsOf('AgentBehavior', loadBehaviors(root, ref, relative, files)),
    ...documentsOf('AgentRouting', loadRoutings(root, ref, relative, files)),
  ];

  console.log(JSON.stringify(values.name ? { environment: { name: values.name }, documents } : { documents }, null, 2));
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
