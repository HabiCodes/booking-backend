import { Request } from 'express';

declare global {
  namespace Express {
    export interface Request {
      organizerUser?: {
        id: number;
        organizationId: number;
        email: string;
        name: string;
        role: 'owner' | 'manager';
        permissions: Record<string, boolean>;
      };
    }
  }
}

export {};
