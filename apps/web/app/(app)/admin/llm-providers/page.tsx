"use client";

import { AlertTriangle, Lock } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  useAdminLlmProviderSettings,
  type AdminLlmProvider,
  type AdminLlmProviderSettings,
} from "@/hooks/use-admin";
import type { ColumnConfig } from "@/lib/column-visibility";
import { useColumnVisibility } from "@/hooks/use-column-visibility";
import { ColumnVisibilityMenu } from "@/components/column-visibility-menu";
import { CopyIdButton } from "@/components/copy-id-button";
import { Badge } from "@/components/ui/badge";
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

// A read-only indicator for now: nothing can be stored or activated yet.
function ActiveIndicator({ label, checked }: { label: string; checked: boolean }) {
  return (
    <input
      type="radio"
      name="llm-active-provider"
      aria-label={label}
      checked={checked}
      readOnly
      disabled
    />
  );
}

function EnvironmentRow({
  environment,
  providers,
  hideableColumnCount,
}: {
  environment: AdminLlmProviderSettings["environmentProvider"];
  providers: AdminLlmProvider[];
  hideableColumnCount: number;
}) {
  const t = useTranslations("admin.llmProviders");
  const name = t("environment.name");
  const resolved = providers.find((provider) => provider.key === environment.key);

  return (
    <TableRow>
      <TableCell>
        <ActiveIndicator label={t("activeLabel", { provider: name })} checked />
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
}: {
  provider: AdminLlmProvider;
  isVisible: (key: LlmProvidersColumn) => boolean;
}) {
  const t = useTranslations("admin.llmProviders");
  const required = provider.parameters.filter((parameter) => parameter.required);

  return (
    <TableRow>
      <TableCell>
        <ActiveIndicator
          label={t("activeLabel", { provider: provider.displayName })}
          checked={provider.active}
        />
      </TableCell>
      <TableCell className="font-medium">{provider.displayName}</TableCell>
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

/**
 * The Admin "LLM providers" screen (issue #174, docs/adr/0024): the five
 * providers the system implements and what each needs to run, led by the
 * "None — follow the environment" row that names what the environment
 * currently resolves to. Read-only for now: nothing is stored, there is no
 * slide-over and no activation yet.
 */
export default function AdminLlmProvidersPage() {
  const t = useTranslations("admin.llmProviders");
  const { data, isPending, isError } = useAdminLlmProviderSettings();
  const columnVisibility = useColumnVisibility(COLUMN_VISIBILITY_STORAGE_KEY, COLUMNS);

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
              hideableColumnCount={hideableColumnCount}
            />
            {data.providers.map((provider) => (
              <ProviderRow key={provider.key} provider={provider} isVisible={columnVisibility.isVisible} />
            ))}
          </TableBody>
        </Table>
      )}
    </main>
  );
}
