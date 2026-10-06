"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ApprovalButtons({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/approvals/${id}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(body.message ?? "Couldn't record your decision.");
      return;
    }
    setDone(decision === "approve" ? "Approved" : "Rejected");
    router.refresh();
  }

  if (done) return <span className="pill pill-ok">{done}, sending to GitHub</span>;
  return (
    <>
      <div className="row">
        <button className="btn btn-sm btn-danger" onClick={() => decide("reject")} disabled={busy}>
          Reject
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => decide("approve")} disabled={busy}>
          Approve
        </button>
      </div>
      {error && <span className="error-text" role="alert">{error}</span>}
    </>
  );
}
