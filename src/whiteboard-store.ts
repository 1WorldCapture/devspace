import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

/**
 * Saved whiteboards. Each project keeps its own boards, keyed by its root
 * (worktrees share their source project's), and boards opened outside any
 * project are global. Opening a project or the global boards resumes the one
 * opened most recently; starting a new board keeps the old ones.
 */

/** A board as listed to the host and in the window's board list. */
export interface WhiteboardBoardSummary {
  id: string;
  title: string;
  /** Project root the board belongs to; absent for a global board. */
  project_root?: string;
  element_count: number;
  created_at: string;
  updated_at: string;
  opened_at: string;
}

/** An image the board shows, as Excalidraw stores it. */
export const whiteboardFileSchema = z.looseObject({ id: z.string(), mimeType: z.string(), dataURL: z.string() });

export type WhiteboardFile = z.infer<typeof whiteboardFileSchema>;

/** What the canvas page saves and loads: Excalidraw elements and the image files they show. */
export interface WhiteboardScene {
  elements: unknown[];
  files: Record<string, WhiteboardFile>;
}

const LIST_LIMIT = 50;

const rowSchema = z.object({
  id: z.string(),
  project_root: z.string().nullable(),
  title: z.string(),
  element_count: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  opened_at: z.string(),
});

const sceneRowSchema = z.object({ elements_json: z.string(), files_json: z.string() });

/** A label inside a shape or on an arrow, counted with its element rather than on its own. */
const labelSchema = z.object({ type: z.literal("text"), containerId: z.string() });

const SUMMARY_COLUMNS = "id, project_root, title, element_count, created_at, updated_at, opened_at";

export class WhiteboardStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  close(): void {
    this.database.close();
  }

  get(id: string): WhiteboardBoardSummary | undefined {
    const row = this.database.sqlite.prepare(`select ${SUMMARY_COLUMNS} from whiteboards where id = ?`).get(id);

    return row ? summary(rowSchema.parse(row)) : undefined;
  }

  /** Boards of one project, or the global boards, most recently opened first. */
  list(projectRoot: string | undefined): WhiteboardBoardSummary[] {
    return this.database.sqlite
      .prepare(`select ${SUMMARY_COLUMNS} from whiteboards where project_root is ? order by opened_at desc, rowid desc limit ?`)
      .all(projectRoot ?? null, LIST_LIMIT)
      .map((row) => summary(rowSchema.parse(row)));
  }

  /** Starts an empty board, numbered after the boards already there. */
  create(projectRoot: string | undefined, title?: string): WhiteboardBoardSummary {
    const count = this.database.sqlite
      .prepare("select count(*) as count from whiteboards where project_root is ?")
      .get(projectRoot ?? null);

    const number = z.object({ count: z.number() }).parse(count).count + 1;
    const now = new Date().toISOString();
    const id = randomUUID();

    this.database.sqlite
      .prepare("insert into whiteboards (id, project_root, title, created_at, updated_at, opened_at) values (?, ?, ?, ?, ?, ?)")
      .run(id, projectRoot ?? null, title?.trim() || `白板 ${number}`, now, now, now);

    return this.require(id);
  }

  /** Records that the board was opened, so it is the one a later open resumes. */
  markOpened(id: string): WhiteboardBoardSummary {
    this.database.sqlite.prepare("update whiteboards set opened_at = ? where id = ?").run(new Date().toISOString(), id);

    return this.require(id);
  }

  scene(id: string): WhiteboardScene {
    const row = sceneRowSchema.parse(this.database.sqlite.prepare("select elements_json, files_json from whiteboards where id = ?").get(id));

    return {
      elements: z.array(z.unknown()).parse(JSON.parse(row.elements_json)),
      files: z.record(z.string(), whiteboardFileSchema).parse(JSON.parse(row.files_json)),
    };
  }

  /** Replaces the board's contents. Returns false when the board no longer exists. */
  save(id: string, scene: WhiteboardScene): boolean {
    const result = this.database.sqlite
      .prepare("update whiteboards set elements_json = ?, files_json = ?, element_count = ?, updated_at = ? where id = ?")
      .run(JSON.stringify(scene.elements), JSON.stringify(scene.files), elementCount(scene.elements), new Date().toISOString(), id);

    return Number(result.changes) > 0;
  }

  private require(id: string): WhiteboardBoardSummary {
    const board = this.get(id);

    if (!board) throw new Error(`No whiteboard with id "${id}".`);

    return board;
  }
}

function summary(row: z.infer<typeof rowSchema>): WhiteboardBoardSummary {
  const { project_root: projectRoot, ...rest } = row;

  return projectRoot === null ? rest : { ...rest, project_root: projectRoot };
}

function elementCount(elements: unknown[]): number {
  return elements.filter((element) => !labelSchema.safeParse(element).success).length;
}
