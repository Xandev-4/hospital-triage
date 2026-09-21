export type UserRole = "patient" | "receptionist" | "doctor";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: UserRole;
      };
    }
  }
}
