"use client";

import { useState } from "react";
import { AlertTriangle, Eraser, LoaderCircle, Lock, Save, Undo2, X } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  useActivateLlmProvider,
  useAdminLlmProviderSettings,
  useDeactivateLlmProvider,
  useSaveLlmProviderSettings,
  type AdminLlmProvider,
  type AdminLlmProviderParameter,
  type AdminLlmProviderSettings,
} from "@/hooks/use-admin";
import { BffError } from "@/lib/bff-client";
import type { ColumnConfig } from "@/lib/column-visibility";
import { useColumnVisibility } from "@/hooks/use-column-visibility";
import { ColumnVisibilityMenu } from "@/components/column-visibility-menu";
import { CopyIdButton } from "@/components/copy-id-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// Active and Provider are the always-visible primary columns (Active carries
// the selection control, which the None row also needs); id is hideable and
// hidden by default like every other Admin table (ADR 0012).
type LlmProvidersColumn =
  | "active"
  | "provider"
  | "maturity"
  | "configuration"
  | "parameters"
  | "updatedAt"
  | "id";

const COLUMNS: ColumnConfig<LlmProvidersColumn>[] = [
  { key: "active", labelKey: "columns.active", hideable: false },
  { key: "provider", labelKey: "columns.provider", hideable: false },
  { key: "maturity", labelKey: "columns.maturity", hideable: true },
  { key: "configuration", labelKey: "columns.configuration", hideable: true },
  { key: "parameters", labelKey: "columns.parameters", hideable: true },
  { key: "updatedAt", labelKey: "columns.updatedAt", hideable: true },
  { key: "id", labelKey: "columns.id", hideable: true, defaultVisible: false },
];

const COLUMN_VISIBILITY_STORAGE_KEY = "column-visibility:admin-llm-providers";

const MATURITY_VARIANT = {
  production: "success",
  "opt-in": "warning",
  "dev-local": "secondary",
} as const;

const CONFIGURATION_VARIANT = {
  configured: "success",
  inherited: "secondary",
  incomplete: "warning",
} as const;

// The API's message for a refused request (a 422 naming the missing parameter,
// say), or null when the failure carries none.
function failureDetail(error: unknown): string | null {
  return error instanceof BffError &&
    typeof error.body === "object" &&
    error.body !== null &&
    "detail" in error.body &&
    typeof error.body.detail === "string"
    ? error.body.detail
    : null;
}

// Controlled by the list the API returned: a refused activation leaves the
// radio where it was, and the refetch settles it on what is really active.
function ActiveRadio({
  label,
  checked,
  disabled,
  onSelect,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <input
      type="radio"
      name="llm-active-provider"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={onSelect}
    />
  );
}

function EnvironmentRow({
  environment,
  providers,
  checked,
  disabled,
  onSelect,
  hideableColumnCount,
}: {
  environment: AdminLlmProviderSettings["environmentProvider"];
  providers: AdminLlmProvider[];
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  hideableColumnCount: number;
}) {
  const t = useTranslations("admin.llmProviders");
  const name = t("environment.name");
  const resolved = providers.find((provider) => provider.key === environment.key);

  return (
    <TableRow>
      <TableCell>
        <ActiveRadio
          label={t("activeLabel", { provider: name })}
          checked={checked}
          disabled={disabled}
          onSelect={onSelect}
        />
      </TableCell>
      <TableCell className="font-medium">
        <div className="flex flex-col gap-1">
          <span>{name}</span>
          {resolved ? (
            <span className="text-xs font-normal text-muted">
              {t("environment.resolvesTo", { provider: resolved.displayName })}
            </span>
          ) : (
            <p className="flex items-start gap-1 text-xs font-normal text-warning">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
              {t("environment.unsupported", { value: environment.unsupportedValue ?? "" })}
            </p>
          )}
        </div>
      </TableCell>
      {hideableColumnCount > 0 && <TableCell colSpan={hideableColumnCount} />}
    </TableRow>
  );
}

function ProviderRow({
  provider,
  isVisible,
  disabled,
  onOpen,
  onActivate,
}: {
  provider: AdminLlmProvider;
  isVisible: (key: LlmProvidersColumn) => boolean;
  disabled: boolean;
  onOpen: () => void;
  onActivate: () => void;
}) {
  const t = useTranslations("admin.llmProviders");
  const required = provider.parameters.filter((parameter) => parameter.required);

  return (
    <TableRow className="cursor-pointer" onClick={onOpen}>
      {/* The radio is its own control: clicking it must not open the slide-over. */}
      <TableCell onClick={(event) => event.stopPropagation()}>
        <ActiveRadio
          label={t("activeLabel", { provider: provider.displayName })}
          checked={provider.active}
          disabled={disabled}
          onSelect={onActivate}
        />
      </TableCell>
      <TableCell className="font-medium">
        {/* A real button so the row is reachable by keyboard; the click bubbles to the row. */}
        <button type="button" className="text-left font-medium hover:underline">
          {provider.displayName}
        </button>
      </TableCell>
      {isVisible("maturity") && (
        <TableCell>
          <Badge variant={MATURITY_VARIANT[provider.maturity]}>{t(`maturity.${provider.maturity}`)}</Badge>
        </TableCell>
      )}
      {isVisible("configuration") && (
        <TableCell>
          <Badge variant={CONFIGURATION_VARIANT[provider.configuration]}>
            {t(`configuration.${provider.configuration}`)}
          </Badge>
        </TableCell>
      )}
      {isVisible("parameters") && (
        <TableCell>
          {required.length === 0 ? (
            <span className="text-sm text-muted">{t("noRequiredParameters")}</span>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {required.map((parameter) => (
                <li key={parameter.name} className="flex items-center gap-1 font-mono text-xs">
                  {parameter.name}
                  {parameter.secret && (
                    <Lock className="size-3 text-muted" role="img" aria-label={t("secretLabel")} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </TableCell>
      )}
      {isVisible("updatedAt") && (
        <TableCell>
          {provider.updatedAt ? new Date(provider.updatedAt).toLocaleString() : "—"}
        </TableCell>
      )}
      {isVisible("id") && (
        <TableCell>
          {provider.settingId ? (
            <div className="flex items-center gap-1">
              <span className="font-mono text-xs text-muted">{provider.settingId}</span>
              <CopyIdButton value={provider.settingId} label={t("columns.copyId")} />
            </div>
          ) : (
            "—"
          )}
        </TableCell>
      )}
    </TableRow>
  );
}

const SOURCE_VARIANT = {
  stored: "success",
  environment: "secondary",
  default: "secondary",
  unresolved: "warning",
} as const;

function useParameterLabel() {
  const t = useTranslations("admin.llmProviders");
  return (name: string) => (t.has(`parameterNames.${name}`) ? t(`parameterNames.${name}`) : name);
}

// A password input that is empty by default -- a stored secret is never sent
// back to the browser -- with the last four characters (or where it comes from)
// as its placeholder. Clear marks a stored value for removal on Save.
function SecretParameter({
  provider,
  parameter,
  draft,
  cleared,
  onDraftChange,
  onClearedChange,
}: {
  provider: AdminLlmProvider;
  parameter: AdminLlmProviderParameter;
  draft: string;
  cleared: boolean;
  onDraftChange: (value: string) => void;
  onClearedChange: (cleared: boolean) => void;
}) {
  const t = useTranslations("admin.llmProviders");
  const label = useParameterLabel();
  const id = `${provider.key}-${parameter.name}`;
  const stored = parameter.source === "stored";
  const placeholder = !parameter.isSet
    ? t("secretPlaceholder.unresolved")
    : !stored
      ? t("secretPlaceholder.environment")
      : parameter.lastFour
        ? t("secretPlaceholder.stored", { lastFour: parameter.lastFour })
        : t("secretPlaceholder.storedNoHint");

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-1 text-sm font-medium" htmlFor={id}>
          {label(parameter.name)}
          <Lock className="size-3 text-muted" role="img" aria-label={t("secretLabel")} />
        </label>
        <Badge variant={SOURCE_VARIANT[parameter.source]}>{t(`sources.${parameter.source}`)}</Badge>
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="password"
          autoComplete="new-password"
          className="h-9"
          placeholder={placeholder}
          value={cleared ? "" : draft}
          disabled={cleared}
          onChange={(event) => onDraftChange(event.target.value)}
        />
        {stored && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              onDraftChange("");
              onClearedChange(!cleared);
            }}
          >
            {cleared ? (
              <Undo2 aria-hidden="true" />
            ) : (
              <Eraser aria-hidden="true" />
            )}
            {t(cleared ? "keepAction" : "clearAction")}
          </Button>
        )}
      </div>
      <span className="text-xs text-muted">
        {cleared ? t("secretWillClear") : stored ? t("secretHelp") : ""}
      </span>
    </div>
  );
}

function ProviderEditForm({ provider, onClose }: { provider: AdminLlmProvider; onClose: () => void }) {
  const t = useTranslations("admin.llmProviders");
  const label = useParameterLabel();
  const save = useSaveLlmProviderSettings(provider.key);
  const editable = provider.parameters.filter((parameter) => !parameter.secret);
  const secrets = provider.parameters.filter((parameter) => parameter.secret);
  // A stored value is pre-filled; an inherited or default one is only a
  // placeholder, so saving without touching it never freezes it into Postgres.
  const initial = Object.fromEntries(
    editable.map((parameter) => [
      parameter.name,
      parameter.source === "stored" ? (parameter.value ?? "") : "",
    ]),
  );
  const [drafts, setDrafts] = useState<Record<string, string>>(initial);
  // A secret is never pre-filled: a typed value replaces it, and Clear removes it.
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [clearedSecrets, setClearedSecrets] = useState<Record<string, boolean>>({});

  // Only what the Administrator changed: a blank secret is left out, so saving
  // another field keeps the stored one.
  function changes(): Record<string, string | null> {
    const changed: Record<string, string | null> = Object.fromEntries(
      editable
        .filter((parameter) => drafts[parameter.name] !== initial[parameter.name])
        .map((parameter) => [parameter.name, drafts[parameter.name]]),
    );
    for (const parameter of secrets) {
      if (clearedSecrets[parameter.name]) {
        changed[parameter.name] = null;
      } else if ((secretDrafts[parameter.name] ?? "").trim() !== "") {
        changed[parameter.name] = secretDrafts[parameter.name];
      }
    }
    return changed;
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle>{provider.displayName}</SheetTitle>
        <div className="flex items-center gap-2">
          <Badge variant={MATURITY_VARIANT[provider.maturity]}>{t(`maturity.${provider.maturity}`)}</Badge>
          <Badge variant={provider.active ? "success" : "secondary"}>
            {t(provider.active ? "activeState.active" : "activeState.inactive")}
          </Badge>
        </div>
      </SheetHeader>
      <div className="flex flex-col gap-4 px-4">
        {provider.parameters.map((parameter) =>
          parameter.secret ? (
            <SecretParameter
              key={parameter.name}
              provider={provider}
              parameter={parameter}
              draft={secretDrafts[parameter.name] ?? ""}
              cleared={clearedSecrets[parameter.name] ?? false}
              onDraftChange={(value) => setSecretDrafts((prev) => ({ ...prev, [parameter.name]: value }))}
              onClearedChange={(cleared) =>
                setClearedSecrets((prev) => ({ ...prev, [parameter.name]: cleared }))
              }
            />
          ) : (
            <div key={parameter.name} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="text-sm font-medium" htmlFor={`${provider.key}-${parameter.name}`}>
                  {label(parameter.name)}
                </label>
                <Badge variant={SOURCE_VARIANT[parameter.source]}>{t(`sources.${parameter.source}`)}</Badge>
              </div>
              <Input
                id={`${provider.key}-${parameter.name}`}
                className="h-9"
                placeholder={parameter.source === "stored" ? "" : (parameter.value ?? "")}
                value={drafts[parameter.name]}
                onChange={(event) =>
                  setDrafts((prev) => ({ ...prev, [parameter.name]: event.target.value }))
                }
              />
            </div>
          ),
        )}
        {save.isError && (
          <p role="alert" className="text-sm text-destructive">
            {failureDetail(save.error) ?? t("saveError")}
          </p>
        )}
      </div>
      <SheetFooter>
        <Button
          disabled={save.isPending}
          onClick={() => save.mutate(changes(), { onSuccess: onClose })}
        >
          {save.isPending ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <Save aria-hidden="true" />
          )}
          {t("saveAction")}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          <X aria-hidden="true" />
          {t("cancelAction")}
        </Button>
      </SheetFooter>
    </>
  );
}

/**
 * The Admin "LLM providers" screen (issues #174/#175, docs/adr/0024): the five
 * providers the system implements and what each needs to run, led by the
 * "None — follow the environment" row that names what the environment
 * currently resolves to. Clicking a provider row opens a slide-over with only
 * that provider's parameters, which can be edited and saved -- an API key
 * is a password input that starts empty (#179).
 * Each row's radio (the None row's included) chooses the Active LLM provider
 * (#176); a refused activation shows the API's message above the table.
 */
export default function AdminLlmProvidersPage() {
  const t = useTranslations("admin.llmProviders");
  const { data, isPending, isError } = useAdminLlmProviderSettings();
  const columnVisibility = useColumnVisibility(COLUMN_VISIBILITY_STORAGE_KEY, COLUMNS);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const activate = useActivateLlmProvider();
  const deactivate = useDeactivateLlmProvider();

  const changingActive = activate.isPending || deactivate.isPending;
  const activationFailure = activate.isError
    ? activate.error
    : deactivate.isError
      ? deactivate.error
      : null;
  const hasActivationFailure = activate.isError || deactivate.isError;

  function selectProvider(key: string) {
    deactivate.reset();
    activate.mutate(key);
  }

  function selectEnvironment() {
    activate.reset();
    deactivate.mutate();
  }

  const editing = data?.providers.find((provider) => provider.key === editingKey) ?? null;
  const visibleColumns = COLUMNS.filter((column) => columnVisibility.isVisible(column.key));
  const hideableColumnCount = visibleColumns.filter((column) => column.hideable).length;

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted">{t("description")}</p>
        </div>
        <ColumnVisibilityMenu
          columns={COLUMNS}
          isVisible={columnVisibility.isVisible}
          onToggle={columnVisibility.toggle}
          onReset={columnVisibility.reset}
          label={t("columnsLabel")}
          columnLabel={(labelKey) => t(labelKey)}
          resetLabel={t("columnsReset")}
        />
      </div>

      {isPending && <p className="text-sm text-muted">{t("loading")}</p>}
      {isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("loadError")}
        </p>
      )}

      {hasActivationFailure && (
        <p role="alert" className="text-sm text-destructive">
          {failureDetail(activationFailure) ?? t("activationError")}
        </p>
      )}

      {data && (
        <Table>
          <TableHeader>
            <TableRow>
              {visibleColumns.map((column) => (
                <TableHead key={column.key}>{t(column.labelKey)}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            <EnvironmentRow
              environment={data.environmentProvider}
              providers={data.providers}
              checked={data.activeProvider === null}
              disabled={changingActive}
              onSelect={selectEnvironment}
              hideableColumnCount={hideableColumnCount}
            />
            {data.providers.map((provider) => (
              <ProviderRow
                key={provider.key}
                provider={provider}
                isVisible={columnVisibility.isVisible}
                disabled={changingActive}
                onOpen={() => setEditingKey(provider.key)}
                onActivate={() => selectProvider(provider.key)}
              />
            ))}
          </TableBody>
        </Table>
      )}

      <Sheet open={editing !== null} onOpenChange={(open) => !open && setEditingKey(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {editing && (
            <ProviderEditForm
              key={editing.key}
              provider={editing}
              onClose={() => setEditingKey(null)}
            />
          )}
        </SheetContent>
      </Sheet>
    </main>
  );
}
