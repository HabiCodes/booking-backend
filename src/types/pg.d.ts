declare module 'pg' {
  export interface FieldDef {
    name: string;
    dataTypeSize: number;
    dataTypeModifier: number;
    format: string;
  }

  export interface QueryResult<R = Record<string, unknown>> {
    command: string;
    rowCount: number;
    oid: number;
    rows: R[];
    fields: FieldDef[];
    _parsers: any[];
    _types: any;
    rowAsArray: boolean;
    [Symbol.iterator](): Iterator<unknown>;
  }

  export interface PoolClient {
    query: (query: string, values?: unknown[]) => Promise<QueryResult>;
    release(): void;
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
  }

  export interface PoolConfig {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    connectionString?: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    ssl?: boolean | { rejectUnauthorized?: boolean };
  }

  export interface Pool extends NodeJS.EventEmitter {
    connect(): Promise<PoolClient>;
    query(text: string, values?: unknown[]): Promise<QueryResult>;
    end(): Promise<void>;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
    once(event: string | symbol, listener: (...args: unknown[]) => void): this;
  }

  export const Pool: {
    prototype: Pool;
    new (config?: PoolConfig): Pool;
  };

  export const types: {
    setTypeParser: (oid: number, format: string, parse: (value: string) => unknown) => void;
  };
}

export interface QueryResultRow {
  [key: string]: unknown;
}
