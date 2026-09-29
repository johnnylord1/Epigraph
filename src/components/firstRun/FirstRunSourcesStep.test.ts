import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import { createFirstRunSourcesWorkflow, type FirstRunRepository } from "../../lib/setup/firstRunSourcesWorkflow";
import FirstRunSourcesStep from "./FirstRunSourcesStep.svelte";
import { applyAppLanguage } from "../../lib/i18n/runtime";

afterEach(() => { cleanup(); applyAppLanguage("en"); });

it("updates the repository hint with the selected app language", async () => {
  const workflow = createFirstRunSourcesWorkflow({ addRepository: vi.fn(), installExtension: vi.fn() });
  render(FirstRunSourcesStep, { props: { workflow } });
  applyAppLanguage("pt-BR");
  await waitFor(() => expect(screen.getByRole("textbox", { name: "URL do repositório" }).getAttribute("placeholder")).toBe("Cole o link do repositório"));
  applyAppLanguage("en");
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Repository URL" }).getAttribute("placeholder")).toBe("Paste a repository link"));
});

it("only shows the empty state after repository loading finishes", async () => {
  let finish!: (repositories: FirstRunRepository[]) => void;
  const workflow = createFirstRunSourcesWorkflow({
    addRepository: vi.fn(), installExtension: vi.fn(),
    loadRepositories: () => new Promise((resolve) => { finish = resolve; }),
  });
  render(FirstRunSourcesStep, { props: { workflow } });
  expect(screen.queryByText("Add a repository to see its extensions.")).toBeNull();
  finish([]);
  expect(await screen.findByText("Add a repository to see its extensions.")).toBeTruthy();
});

it("uses the compact repository and extension workflow without nested Browse chrome", async () => {
  const workflow = createFirstRunSourcesWorkflow({
    addRepository: vi.fn(async (kind, url): Promise<FirstRunRepository> => ({
      id: "repo", kind, url, name: "Keiyoushi",
      extensions: [{ id: "ext", name: "MangaDex", lang: "en", version: "1.2", iconUrl: null, installed: false, status: "idle" }],
    })),
    installExtension: vi.fn(async () => undefined),
  });
  const onContinue = vi.fn();
  const { container } = render(FirstRunSourcesStep, { props: { workflow, requiredKinds: ["manga"], onContinue } });

  expect(screen.getByRole("heading", { name: "Add repositories" })).toBeTruthy();
  expect(container.querySelector(".browse-topbar, .sources-page, .rail")).toBeNull();
  const add = screen.getByRole("button", { name: "Add" });
  expect(add.hasAttribute("disabled")).toBe(true);
  await fireEvent.input(screen.getByRole("textbox", { name: "Repository URL" }), { target: { value: "https://repo.test/index.min.json" } });
  await fireEvent.click(add);
  expect(await screen.findByText("MangaDex")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
  await fireEvent.click(screen.getByRole("button", { name: "Install MangaDex" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false));
  await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(onContinue).toHaveBeenCalledOnce();
});

it("bounds large catalogs, supports searching, and does not offer to install an entire unfiltered repository", async () => {
  const workflow = createFirstRunSourcesWorkflow({
    addRepository: vi.fn(), installExtension: vi.fn(),
    loadRepositories: async () => [{ id: "large", kind: "manga", name: "Large", url: "https://large.test", extensions: Array.from({ length: 30 }, (_, index) => ({ id: `ext-${index}`, name: `Extension ${index}`, lang: "en", version: "1", iconUrl: null, installed: false, status: "idle" as const })) }],
  });
  render(FirstRunSourcesStep, { props: { workflow, requiredKinds: ["manga"] } });
  await screen.findByText("Large");
  expect(screen.queryByRole("button", { name: "Install all" })).toBeNull();
  expect(screen.getAllByRole("button", { name: /^Install Extension/ })).toHaveLength(12);
  await fireEvent.input(screen.getByRole("searchbox", { name: "Search extensions" }), { target: { value: "Extension 29" } });
  expect(screen.getAllByRole("button", { name: /^Install Extension/ })).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Install Extension 29" })).toBeTruthy();
});

it("shows installation progress while blocking navigation, then exposes a retry after failure", async () => {
  let rejectInstall!: (cause: Error) => void;
  const installExtension = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { rejectInstall = reject; })).mockResolvedValue(undefined);
  const workflow = createFirstRunSourcesWorkflow({
    addRepository: vi.fn(), installExtension,
    loadRepositories: async () => [{ id: "repo", kind: "manga", name: "Repo", url: "https://repo.test", extensions: [{ id: "ext", name: "Extension", lang: "en", version: "1", iconUrl: null, installed: false, status: "idle" }] }],
  });
  const onBack = vi.fn();
  render(FirstRunSourcesStep, { props: { workflow, onBack } });
  await screen.findByText("Repo");
  await waitFor(() => expect(screen.getByRole("button", { name: "Install Extension" }).hasAttribute("disabled")).toBe(false));
  await fireEvent.click(screen.getByRole("button", { name: "Install Extension" }));
  expect(await screen.findByText("Installing…")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
  await fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(onBack).not.toHaveBeenCalled();
  rejectInstall(new Error("Connection interrupted"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Install Extension" }).hasAttribute("disabled")).toBe(false));
  expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
  await fireEvent.click(screen.getByRole("button", { name: "Install Extension" }));
  expect(await screen.findByText("Installed")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
});
