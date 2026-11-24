import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';

// voiceflow.yaml at the working directory binds the repo to a project and maps git branches to environment aliases
export const readConfig = () => {
  const configPath = path.resolve('voiceflow.yaml');
  if (!existsSync(configPath)) return { branches: {} };
  const config = parse(readFileSync(configPath, 'utf8')) ?? {};
  const spec = config.spec ?? {};
  return { projectID: spec.projectID, branches: spec.branches ?? {}, apiURL: spec.api?.url };
};

// GITHUB_REF_NAME in Actions, the checked-out branch elsewhere
export const currentBranch = () => {
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return branch === 'HEAD' ? undefined : branch;
  } catch {
    return undefined;
  }
};

export const branchEnvironment = (config, branch = currentBranch()) =>
  branch && Object.hasOwn(config.branches, branch) ? config.branches[branch] : undefined;
