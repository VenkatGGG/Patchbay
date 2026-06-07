import { ControlPlaneDashboard } from "@/components/control-plane-dashboard";
import { operatorAuthStatus } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

export default function Home() {
  const operatorAuth = operatorAuthStatus();
  return <ControlPlaneDashboard initialOperatorAuthRequired={operatorAuth.required} />;
}
