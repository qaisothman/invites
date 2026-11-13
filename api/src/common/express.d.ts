// Fields this app adds to Express's Request object.
declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export {};
