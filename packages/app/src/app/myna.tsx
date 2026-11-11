import { Redirect, useLocalSearchParams } from "expo-router";
import { buildModelsRoute, isModelsView } from "@/utils/host-routes";

/** `/myna` was the old address; the page now lives at `/models`. */
export default function MynaRoute() {
  const params = useLocalSearchParams<{ view?: string; host?: string }>();
  const view = isModelsView(params.view) ? params.view : "overview";
  return <Redirect href={buildModelsRoute({ serverId: params.host, view })} />;
}
