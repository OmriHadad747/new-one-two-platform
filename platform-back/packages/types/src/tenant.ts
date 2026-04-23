export type TenantStatus = "active" | "suspended" | "pending";

export interface TenantBrand {
  tenantId: string;
  logoUrl: string | null;
  primaryColor: string | null;
  footerText: string | null;
  supportEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
}
