import os from 'node:os';
import path from 'node:path';

export const BASE_DIR_ENV = 'CONTEXTATLAS_BASE_DIR';
export const USAGE_DB_PATH_ENV = 'CONTEXTATLAS_USAGE_DB_PATH';

export function expandHome(rawPath: string): string {
  if (rawPath.startsWith('~/')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

export function contextAtlasBaseDir(): string {
  return path.join(os.homedir(), '.contextatlas');
}

export function resolveBaseDir(): string {
  const explicitAtlas = process.env[BASE_DIR_ENV];
  if (explicitAtlas && explicitAtlas.trim()) {
    return path.resolve(expandHome(explicitAtlas.trim()));
  }

  return contextAtlasBaseDir();
}

export function resolveUsageDbPathFromEnv(): string | null {
  const explicitAtlas = process.env[USAGE_DB_PATH_ENV];
  if (explicitAtlas && explicitAtlas.trim()) {
    return path.resolve(expandHome(explicitAtlas.trim()));
  }

  return null;
}

export function defaultConfigEnvPath(): string {
  return path.join(contextAtlasBaseDir(), '.env');
}

export function resolveConfigEnvCandidates(isDev: boolean): string[] {
  const atlasEnv = path.join(contextAtlasBaseDir(), '.env');

  if (isDev) {
    return [path.join(process.cwd(), '.env'), atlasEnv];
  }

  return [atlasEnv];
}
