-- Add internal plan for bypassing billing restrictions in dev/testing
ALTER TYPE billing_plan ADD VALUE IF NOT EXISTS 'internal';
