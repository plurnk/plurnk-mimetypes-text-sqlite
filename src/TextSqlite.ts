import { AntlrExtractor, withExtractor } from "@plurnk/plurnk-mimetypes";
import type { ExtractionVisitor } from "@plurnk/plurnk-mimetypes";
import { CharStream, CommonTokenStream } from "antlr4ng";
import { SQLiteLexer } from "./generated/SQLiteLexer.ts";
import { SQLiteParser } from "./generated/SQLiteParser.ts";
import { SQLiteParserVisitor } from "./generated/SQLiteParserVisitor.ts";

// text/x-sqlite-sql handler. ANTLR grammar from grammars-v4/sql/sqlite.
//
// Parser entry rule: parse → sql_stmt_list EOF.
// We extract DDL declarations (the things a developer DECLARES, not the
// per-row data manipulations they EXECUTE).
export default class TextSqlite extends AntlrExtractor {
    protected parseTree(content: string): unknown {
        const lexer = new SQLiteLexer(CharStream.fromString(content));
        const tokens = new CommonTokenStream(lexer);
        const parser = new SQLiteParser(tokens);
        parser.removeErrorListeners();
        return parser.parse();
    }

    protected createVisitor(): ExtractionVisitor {
        return new TextSqliteVisitor() as unknown as ExtractionVisitor;
    }
}

// SPEC §3 mapping for SQLite source files:
//   CREATE TABLE name (...)         → class (name); each column_def → field
//   CREATE VIRTUAL TABLE name USING → class (name); fts/rtree modules
//   CREATE VIEW name AS ...         → class (a view IS a named result set)
//   CREATE INDEX name ON table      → field (index attaches to its table)
//   CREATE TRIGGER name ON table    → method
//   ALTER TABLE ... ADD COLUMN c    → field (best-effort)
//   SELECT / INSERT / UPDATE / DELETE / PRAGMA / BEGIN / COMMIT / etc. →
//                                     excluded (data manipulation, not
//                                     declaration)
class TextSqliteVisitor extends withExtractor(SQLiteParserVisitor) {
    visitCreate_table_stmt = (ctx: any): null => {
        if (this.inBody) return null;
        const name = sqliteNameText(ctx.table_name?.());
        if (!name) return null;
        this.addSymbol("class", name, ctx);
        const cols = collectChildren(ctx, "column_def");
        for (const col of cols) {
            const colName = sqliteNameText(
                (col as { column_name?: () => unknown }).column_name?.(),
            );
            if (colName) this.addSymbol("field", colName, ctx);
        }
        return null;
    };

    visitCreate_virtual_table_stmt = (ctx: any): null => {
        if (this.inBody) return null;
        const name = sqliteNameText(ctx.table_name?.());
        if (name) this.addSymbol("class", name, ctx);
        return null;
    };

    visitCreate_view_stmt = (ctx: any): null => {
        if (this.inBody) return null;
        const name = sqliteNameText(ctx.view_name?.());
        if (name) this.addSymbol("class", name, ctx);
        return null;
    };

    visitCreate_index_stmt = (ctx: any): null => {
        if (this.inBody) return null;
        const name = sqliteNameText(ctx.index_name?.());
        if (name) this.addSymbol("field", name, ctx);
        return null;
    };

    visitCreate_trigger_stmt = (ctx: any): null => {
        if (this.inBody) return null;
        const name = sqliteNameText(ctx.trigger_name?.());
        if (name) this.addSymbol("method", name, ctx);
        return null;
    };
}

// Names in the SQLite grammar are wrapped contexts that often resolve to a
// single any_name terminal. Strip surrounding quoting characters
// (double-quote / backtick / square-bracket identifiers) when present.
function sqliteNameText(ctx: unknown): string | null {
    if (!ctx) return null;
    const raw = (ctx as { getText?: () => string }).getText?.();
    if (!raw) return null;
    return unquoteSqlIdentifier(raw);
}

function unquoteSqlIdentifier(s: string): string {
    if (s.length >= 2) {
        const first = s[0];
        const last = s[s.length - 1];
        if (first === '"' && last === '"') return s.slice(1, -1).replace(/""/g, '"');
        if (first === "`" && last === "`") return s.slice(1, -1).replace(/``/g, "`");
        if (first === "[" && last === "]") return s.slice(1, -1);
        if (first === "'" && last === "'") return s.slice(1, -1).replace(/''/g, "'");
    }
    return s;
}

function collectChildren(ctx: unknown, methodName: string): unknown[] {
    const node = ctx as Record<string, unknown>;
    const accessor = node[methodName] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof accessor !== "function") return [];
    const raw = accessor.call(node);
    if (Array.isArray(raw)) return raw;
    return raw ? [raw] : [];
}
