import type postgres from "postgres";

export interface PaginateInput {
  page?: number | string | null;
  page_size?: number | string | null;
}

export interface PaginateOptions {
  maxPageSize?: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export async function paginate<T extends postgres.Row>(
  sql: postgres.Sql,
  baseQuery: postgres.PendingQuery<T[]>,
  input: PaginateInput,
  options: PaginateOptions = {},
): Promise<PaginatedResponse<T>> {
  const maxPageSize = options.maxPageSize ?? 100;
  const pageNum = input.page == null ? 1 : Number(input.page);
  const sizeNum = input.page_size == null ? 20 : Number(input.page_size);
  const page = Math.max(1, Number.isFinite(pageNum) ? pageNum : 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, Number.isFinite(sizeNum) ? sizeNum : 20));
  const offset = (page - 1) * pageSize;

  const [countResult, rows] = await Promise.all([
    sql<{ count: string }[]>`SELECT COUNT(*) AS count FROM (${baseQuery}) AS _count`,
    sql<T[]>`SELECT * FROM (${baseQuery}) AS _page LIMIT ${pageSize} OFFSET ${offset}`,
  ]);

  return {
    items: Array.from(rows) as T[],
    total: Number(countResult[0]?.count ?? 0),
    page,
    page_size: pageSize,
  };
}
