CREATE TABLE product_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_external_id BIGINT NOT NULL,
  shopper_identifier TEXT NULL,
  question_text TEXT NOT NULL,
  answer_text TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'published', 'rejected')),
  answered_at TIMESTAMPTZ NULL,
  visibility_decided_at TIMESTAMPTZ NULL,
  failure_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE product_questions IS 'Stores every shopper-submitted question and the merchant''s answer, along with the lifecycle status that controls storefront visibility.';
COMMENT ON COLUMN product_questions.product_external_id IS 'Shopify numeric product ID this question belongs to';
COMMENT ON COLUMN product_questions.shopper_identifier IS 'Logged-in customer ID or guest token supplied by the widget';
COMMENT ON COLUMN product_questions.failure_reason IS 'Records error message when a workflow transition fails';

CREATE INDEX idx_product_questions_status_product_external_id_created_at ON product_questions (status, product_external_id, created_at);
CREATE INDEX idx_product_questions_status_created_at ON product_questions (status, created_at);
CREATE INDEX idx_product_questions_product_external_id_status ON product_questions (product_external_id, status);