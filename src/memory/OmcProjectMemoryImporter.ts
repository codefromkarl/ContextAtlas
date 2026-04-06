import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MemoryHubDatabase } from './MemoryHubDatabase.js';
import type { GlobalMemory, ProjectProfile } from './types.js';
import type { MemoryStore } from './MemoryStore.js';

const OMC_PROJECT_MEMORY_PATH = path.join('.omc', 'project-memory.json');
const GLOBAL_META_PREFIX = 'global:';

interface OmcLanguageEntry {
  name?: string;
}

interface OmcNamedEntry {
  name?: string;
}

interface OmcProjectMemoryPayload {
  projectRoot?: string;
  lastScanned?: number;
  techStack?: {
    languages?: OmcLanguageEntry[];
    frameworks?: OmcNamedEntry[];
    packageManager?: string | null;
    runtime?: string | null;
  };
  build?: {
    buildCommand?: string | null;
    testCommand?: string | null;
    devCommand?: string | null;
    startCommand?: string | null;
    scripts?: Record<string, string>;
  };
  conventions?: {
    namingStyle?: string | null;
    importStyle?: string | null;
    testPattern?: string | null;
    fileOrganization?: string | null;
  };
  structure?: {
    mainDirectories?: string[];
  };
  directoryMap?: Record<
    string,
    {
      path?: string;
      purpose?: string;
      keyFiles?: string[];
    }
  >;
  hotPaths?: Array<{ path?: string; type?: string }>;
  userDirectives?: string[];
}

export interface OmcImportResult {
  imported: boolean;
  source: string;
  importedGlobals: string[];
  reason?: 'missing-file' | 'already-exists';
}

function wrapGlobal(type: 'profile' | 'conventions' | 'cross-cutting', data: Record<string, unknown>) {
  const payload: GlobalMemory = {
    type,
    data,
    lastUpdated: new Date().toISOString(),
  };
  return JSON.stringify(payload);
}

function pickNamedValues(entries: Array<OmcLanguageEntry | OmcNamedEntry> | undefined): string[] {
  if (!entries) {
    return [];
  }
  return entries
    .map((entry) => entry?.name?.trim())
    .filter((entry): entry is string => Boolean(entry));
}

function toCommandList(value?: string | null): string[] {
  return value ? [value] : [];
}

function resolveMainEntry(payload: OmcProjectMemoryPayload): string {
  const hotPath = payload.hotPaths?.find((entry) => entry.type === 'file' && entry.path?.startsWith('src/'));
  if (hotPath?.path) {
    return hotPath.path;
  }

  const srcDir = payload.directoryMap?.src;
  const keyFile = srcDir?.keyFiles?.find((file) => file.endsWith('.ts') || file.endsWith('.js'));
  if (keyFile) {
    return srcDir?.path ? `${srcDir.path}/${keyFile}`.replace(/\/{2,}/g, '/') : keyFile;
  }

  return 'src/index.ts';
}

function resolveKeyModules(payload: OmcProjectMemoryPayload): ProjectProfile['structure']['keyModules'] {
  const entries = Object.entries(payload.directoryMap || {})
    .filter(([, entry]) => entry?.path?.startsWith('src'))
    .slice(0, 5);

  return entries.map(([name, entry]) => ({
    name,
    path: entry.path || name,
    description: entry.purpose || 'Imported from .omc project memory',
  }));
}

function convertOmcProjectMemoryToProfile(
  projectRoot: string,
  payload: OmcProjectMemoryPayload,
): ProjectProfile {
  const name = path.basename(projectRoot) || 'project';
  const lastUpdated = payload.lastScanned
    ? new Date(payload.lastScanned).toISOString()
    : new Date().toISOString();

  return {
    name,
    description: 'Imported from .omc/project-memory.json',
    techStack: {
      language: pickNamedValues(payload.techStack?.languages),
      frameworks: pickNamedValues(payload.techStack?.frameworks),
      databases: [],
      tools: [
        payload.techStack?.packageManager || undefined,
        payload.techStack?.runtime || undefined,
      ].filter((entry): entry is string => Boolean(entry)),
    },
    structure: {
      srcDir: payload.structure?.mainDirectories?.find((entry) => entry === 'src') || 'src',
      mainEntry: resolveMainEntry(payload),
      keyModules: resolveKeyModules(payload),
    },
    conventions: {
      namingConventions: payload.conventions?.namingStyle ? [payload.conventions.namingStyle] : [],
      codeStyle: [
        payload.conventions?.importStyle || undefined,
        payload.conventions?.testPattern || undefined,
        payload.conventions?.fileOrganization || undefined,
      ].filter((entry): entry is string => Boolean(entry)),
      gitWorkflow: 'unspecified',
    },
    commands: {
      build: toCommandList(payload.build?.buildCommand),
      test: toCommandList(payload.build?.testCommand),
      dev: toCommandList(payload.build?.devCommand),
      start: toCommandList(payload.build?.startCommand),
    },
    lastUpdated,
  };
}

async function readOmcPayload(projectRoot: string): Promise<OmcProjectMemoryPayload | null> {
  const filePath = path.join(projectRoot, OMC_PROJECT_MEMORY_PATH);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as OmcProjectMemoryPayload;
  } catch {
    return null;
  }
}

export async function importOmcProjectProfileIfNeeded(params: {
  projectRoot: string;
  projectId: string;
  hub: MemoryHubDatabase;
  force?: boolean;
}): Promise<OmcImportResult> {
  const payload = await readOmcPayload(params.projectRoot);
  if (!payload) {
    return {
      imported: false,
      source: OMC_PROJECT_MEMORY_PATH,
      importedGlobals: [],
      reason: 'missing-file',
    };
  }

  const existingProfile = params.hub.getProjectMeta(params.projectId, `${GLOBAL_META_PREFIX}profile`);
  if (existingProfile && !params.force) {
    return {
      imported: false,
      source: OMC_PROJECT_MEMORY_PATH,
      importedGlobals: [],
      reason: 'already-exists',
    };
  }

  const profile = convertOmcProjectMemoryToProfile(params.projectRoot, payload);
  const importedGlobals: string[] = [];

  params.hub.setProjectMeta(
    params.projectId,
    `${GLOBAL_META_PREFIX}profile`,
    wrapGlobal('profile', profile as unknown as Record<string, unknown>),
  );
  importedGlobals.push('profile');

  const conventions = payload.conventions || {};
  params.hub.setProjectMeta(
    params.projectId,
    `${GLOBAL_META_PREFIX}conventions`,
    wrapGlobal('conventions', {
      ...conventions,
      packageManager: payload.techStack?.packageManager || null,
      runtime: payload.techStack?.runtime || null,
      scripts: payload.build?.scripts || {},
    }),
  );
  importedGlobals.push('conventions');

  params.hub.setProjectMeta(
    params.projectId,
    `${GLOBAL_META_PREFIX}cross-cutting`,
    wrapGlobal('cross-cutting', {
      directoryMap: payload.directoryMap || {},
      hotPaths: payload.hotPaths || [],
      userDirectives: payload.userDirectives || [],
    }),
  );
  importedGlobals.push('cross-cutting');

  return {
    imported: true,
    source: OMC_PROJECT_MEMORY_PATH,
    importedGlobals,
  };
}

export async function importOmcProjectProfile(params: {
  projectRoot: string;
  store: MemoryStore;
  force?: boolean;
}): Promise<OmcImportResult> {
  await params.store.initializeWritable();
  return importOmcProjectProfileIfNeeded({
    projectRoot: params.projectRoot,
    projectId: params.store.getProjectId(),
    hub: (params.store as unknown as { hub: MemoryHubDatabase }).hub,
    force: params.force,
  });
}
