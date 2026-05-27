import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedSession } from "../types.js";
import type { Session } from "./session.js";

interface StoreFile {
  version: number;
  sessions: PersistedSession[];
}

/** Disk persistence for Even-visible bridge sessions. */
export class StateStore {
  readonly file: string;

  constructor(readonly stateDir: string) {
    this.file = join(stateDir, "sessions.json");
    mkdirSync(stateDir, { recursive: true });
  }

  /** Load sessions defensively; corrupt state should not prevent startup. */
  load(): PersistedSession[] {
    if (!existsSync(this.file)) {
      return [];
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoreFile>;
      return Array.isArray(parsed.sessions) ? parsed.sessions : [];
    } catch {
      return [];
    }
  }

  /** Save the compact state that Even App needs for its session list/history. */
  save(sessions: Iterable<Session>): void {
    const data: StoreFile = {
      version: 1,
      sessions: [...sessions].map((session) => session.toJSON()),
    };
    writeFileSync(this.file, JSON.stringify(data, null, 2));
  }
}
