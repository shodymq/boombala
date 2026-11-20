import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("../..", import.meta.url)), "deploy/kz/google-apps-script/Code.gs");
const source = readFileSync(root, "utf8");
const header = { headerRow: 1, idColumn: 4, businessColumns: [1, 2, 3] };

function harness(rows: string[][]) {
  const grid = rows.map((row) => [...row]);
  let uuid = 0;
  const context = { Utilities: { getUuid: () => `new-sync-id-${++uuid}` } };
  runInNewContext(source, context);
  const sheet = {
    getLastColumn: () => Math.max(1, ...grid.map((row) => row.length)),
    getLastRow: () => grid.length,
    getRange(row: number, column: number, rowCount: number, columnCount: number) {
      return {
        getDisplayValues: () => grid.slice(row - 1, row - 1 + rowCount).map((cells) =>
          Array.from({ length: columnCount }, (_, offset) => cells[column - 1 + offset] ?? "")),
        setNumberFormat: () => undefined,
        setValues(values: string[][]) {
          values.forEach((cells, rowOffset) => {
            while (grid[row - 1 + rowOffset].length < column - 1 + cells.length) grid[row - 1 + rowOffset].push("");
            cells.forEach((value, columnOffset) => { grid[row - 1 + rowOffset][column - 1 + columnOffset] = value; });
          });
        },
      };
    },
  };
  const assignIds = (context as { assignIds_?: (s: typeof sheet, h: typeof header, first: number, count: number, options?: { repairDuplicatesInRange?: boolean }) => void }).assignIds_;
  assert.ok(assignIds);
  return { grid, sheet, assignIds };
}

test("Apps Script IDs: assigns an immutable ID to newly populated and inserted rows", () => {
  const { grid, sheet, assignIds } = harness([
    ["Дата", "Время", "Клиент", "CRM Sync ID"],
    ["28.11.2026", "14:00", "Existing", "original-id"],
    ["29.11.2026", "15:00", "Inserted blank ID", ""],
  ]);
  assignIds(sheet, header, 3, 1);
  assert.equal(grid[1][3], "original-id");
  assert.equal(grid[2][3], "new-sync-id-1");
});

test("Apps Script IDs: a pasted copied row gets a new ID while the source keeps its ID", () => {
  const { grid, sheet, assignIds } = harness([
    ["Дата", "Время", "Клиент", "CRM Sync ID"],
    ["28.11.2026", "14:00", "Copied row", "original-id"],
    ["28.11.2026", "14:00", "Copied row", "original-id"],
  ]);
  assignIds(sheet, header, 3, 1, { repairDuplicatesInRange: true });
  assert.equal(grid[1][3], "original-id");
  assert.equal(grid[2][3], "new-sync-id-1");
});

test("Apps Script IDs: ambiguous structural duplicates fail closed without transferring identity", () => {
  const { grid, sheet, assignIds } = harness([
    ["Дата", "Время", "Клиент", "CRM Sync ID"],
    ["28.11.2026", "14:00", "Copied row", "original-id"],
    ["28.11.2026", "14:00", "Copied row", "original-id"],
  ]);
  assert.throws(() => assignIds(sheet, header, 2, 2), /crm_sync_duplicate_id_requires_owner_reconcile/);
  assert.deepEqual(grid.slice(1).map((row) => row[3]), ["original-id", "original-id"]);
});

test("Apps Script IDs: sorting the whole row leaves each identity attached to its business cells", () => {
  const { grid, sheet, assignIds } = harness([
    ["Дата", "Время", "Клиент", "CRM Sync ID"],
    ["29.11.2026", "15:00", "Later", "id-later"],
    ["28.11.2026", "14:00", "Earlier", "id-earlier"],
  ]);
  assignIds(sheet, header, 2, 2);
  assert.deepEqual(grid.slice(1).map((row) => [row[2], row[3]]), [["Later", "id-later"], ["Earlier", "id-earlier"]]);
});
