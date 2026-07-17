import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

// Project registry: the places agents work. Seeded automatically from every
// session start (so it fills itself from real usage, happy-style) and
// editable explicitly; per-project delivery mode fields ride along for the
// task layer (M1) and the mate (M2).

export type Project = {
  rootPath: string;
  name: string;
  // Delivery mode for tasks in this project (M1+): how work ships.
  mode?: "direct-PR" | "no-mistakes" | "local-only";
  // Self-approval for green work (M2); destructive actions always escalate.
  yolo?: boolean;
  addedAt: string;
  lastUsedAt: string;
};

type ProjectsFile = {
  projects: Project[];
};

const MAX_PROJECTS = 100;

export class ProjectRegistry {
  private readonly path: string;
  private cache?: { projects: Project[]; mtimeMs: number };

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.path = join(env.PERCH_HOME ?? join(homedir(), ".perch"), "projects.json");
  }

  list(): Project[] {
    return this.load()
      .slice()
      .sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1));
  }

  // Record usage of a directory (called on every session start). Registers
  // unknown paths and bumps lastUsedAt on known ones.
  touch(rootPath: string, fields: Partial<Pick<Project, "mode" | "yolo" | "name">> = {}): Project {
    const root = resolve(rootPath);
    const projects = this.load();
    const now = new Date().toISOString();

    let project = projects.find((candidate) => candidate.rootPath === root);
    if (!project) {
      project = {
        rootPath: root,
        name: fields.name ?? basename(root),
        addedAt: now,
        lastUsedAt: now
      };
      projects.push(project);
      // Bound the registry: drop the least recently used beyond the cap.
      if (projects.length > MAX_PROJECTS) {
        projects.sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1));
        projects.length = MAX_PROJECTS;
      }
    }
    project.lastUsedAt = now;
    if (fields.name) {
      project.name = fields.name;
    }
    if (fields.mode) {
      project.mode = fields.mode;
    }
    if (fields.yolo !== undefined) {
      project.yolo = fields.yolo;
    }
    this.persist(projects);
    return { ...project };
  }

  find(rootPath: string): Project | undefined {
    const root = resolve(rootPath);
    const project = this.load().find((candidate) => candidate.rootPath === root);
    return project ? { ...project } : undefined;
  }

  // Unregister a project. Registry-only: the directory on disk is untouched.
  remove(rootPath: string): boolean {
    const root = resolve(rootPath);
    const projects = this.load();
    const remaining = projects.filter((candidate) => candidate.rootPath !== root);
    if (remaining.length === projects.length) {
      return false;
    }
    this.persist(remaining);
    return true;
  }

  private load(): Project[] {
    try {
      const mtimeMs = statSync(this.path).mtimeMs;
      if (this.cache && this.cache.mtimeMs === mtimeMs) {
        return this.cache.projects;
      }
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as ProjectsFile;
      const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
      this.cache = { projects, mtimeMs };
      return projects;
    } catch {
      return this.cache?.projects ?? [];
    }
  }

  private persist(projects: Project[]): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ projects } satisfies ProjectsFile, null, 2)}\n`, {
      mode: 0o600
    });
    renameSync(tmp, this.path);
    if (existsSync(this.path)) {
      this.cache = { projects, mtimeMs: statSync(this.path).mtimeMs };
    }
  }
}
