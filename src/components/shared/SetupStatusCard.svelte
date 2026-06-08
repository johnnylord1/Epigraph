<script lang="ts">
  import type { SetupActionKind, SetupState, SetupSurface } from "../../lib/setupState";
  import { getSetupStatePresentation } from "../../lib/setupState";
  import NocturneState from "./NocturneState.svelte";

  let {
    state,
    surface,
    actionBusy = false,
    onAddRecommendedRepo = () => {},
    onAddManually = () => {},
    onBrowseAvailableExtensions = () => {},
    onOpenExtensions = () => {},
    onOpenRepoManager = () => {},
    onRetry = () => {},
  }: {
    state: SetupState;
    surface: SetupSurface;
    actionBusy?: boolean;
    onAddRecommendedRepo?: () => void;
    onAddManually?: () => void;
    onBrowseAvailableExtensions?: () => void;
    onOpenExtensions?: () => void;
    onOpenRepoManager?: () => void;
    onRetry?: () => void;
  } = $props();

  const content = $derived(getSetupStatePresentation(state, surface));
  const tone = $derived(state.kind === "server_offline" ? "danger" : state.kind === "ready" ? "success" : "warning");
  const icon = $derived(state.kind === "server_offline" ? "plug" : state.kind === "ready" ? "info" : "warning");
  const detail = $derived(state.kind === "server_offline" && state.errorMessage ? state.errorMessage : "");
  const actions = $derived(content.actions.map((action) => ({
    label: action.label,
    kind: action.kind === "add_recommended_repo" || action.kind === "browse_available_extensions" ? "primary" as const : "secondary" as const,
    disabled: actionBusy,
    icon: action.kind === "retry_connection" ? "retry" as const : action.kind === "open_repo_manager" || action.kind === "add_manually" ? "folder" as const : "info" as const,
    onClick: () => handleAction(action.kind),
  })));

  function handleAction(kind: SetupActionKind) {
    if (kind === "add_recommended_repo") onAddRecommendedRepo();
    if (kind === "add_manually") onAddManually();
    if (kind === "browse_available_extensions") onBrowseAvailableExtensions();
    if (kind === "open_extensions") onOpenExtensions();
    if (kind === "open_repo_manager") onOpenRepoManager();
    if (kind === "retry_connection") onRetry();
  }
</script>

<NocturneState
  eyebrow="Setup status"
  title={content.title}
  body={content.body}
  {detail}
  {tone}
  {icon}
  actions={actions}
/>
