-- 0018_builder_graphs — Milestone J: persist the visual-builder canvas (BUILD-CHECKLIST-visual-builder.md).
--
-- Until now the canvas graph lived only in browser state: Deploy consumed it via
-- compileGraphToConfig and threw it away, so a reload left an empty canvas even though the agents
-- and policies it created were real. configToGraph can rebuild a graph from deployed config, but
-- it is lossy — node POSITIONS and any not-yet-deployed nodes have no representation in the
-- compiled config. This table stores the graph verbatim (nodes/edges/positions as authored) so the
-- canvas restores exactly as drawn.
--
-- The graph is a DESIGN DOCUMENT, not an enforcement surface. Nothing reads this table on the
-- authorization hot path; policy enforcement continues to come solely from policy_versions /
-- policy_assignments. Deleting a row here cannot widen a cap or un-revoke an agent.

CREATE TABLE IF NOT EXISTS builder_graphs (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES orgs (id),
  name          text NOT NULL,
  -- Full BuilderGraph: { nodes: [{id,type,config,position}], edges: [{from,to,kind}] }.
  -- Stored as authored so the canvas round-trips without a lossy configToGraph rebuild.
  graph         jsonb NOT NULL,
  -- Set once a Deploy succeeds. NULL = draft that has never been deployed.
  deployed_at   timestamptz,
  -- role -> { agentId, policyId } from attachTradingFlow, so a restored canvas can map its
  -- Agent nodes back to the real agents they created (drives Milestone I.5 live status).
  role_bindings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Tenant-scoped listing ("my graphs, newest first") is the only read pattern.
CREATE INDEX IF NOT EXISTS builder_graphs_org_idx ON builder_graphs (org_id, updated_at DESC);
