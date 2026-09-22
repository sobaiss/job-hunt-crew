"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslations } from "next-intl";
import {
  Check,
  Clock,
  LoaderCircle,
  Pencil,
  RotateCw,
  Star,
  Upload,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useConvertCvVersion,
  useCreateCvVersion,
  useCvVersionConversion,
  useCvVersions,
  useReplaceCvVersion,
  useSetDefaultCvVersion,
  apiErrorCode,
  apiErrorDetail,
  discardCvVersion,
  firstFile,
  CvStoreError,
  ACCEPTED_CV_CONTENT_TYPES,
  CV_FILE_ACCEPT,
  MAX_CV_SIZE_BYTES,
} from "@/hooks/use-cv-versions";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { CvMarkdownContent } from "@/components/cv-markdown-content";
import { CvPaper, CV_PAGE_COLUMN_CLASS } from "@/components/cv-paper";
import { cn } from "@/lib/utils";

// The Import screen (issue #194, apps/web/CONTEXT.md → Import): the whole act
// of adding a CV, in place — create the CVVersion, PUT the bytes, then start
// the Conversion (after the PUT, never before: docs/adr/0028) and poll its
// rendition until it is terminal. On success the CV is rendered as HTML in
// the same paper frame the skeleton held, so there is no layout jump.
// The two halves fail apart (issue #195): storing the CV failed means there
// is no usable file, so the offer is to retry the upload and the half-created
// row is discarded on close; converting it failed means the file is stored
// and the row is legitimate, so the offer is to retry the Conversion or
// replace the file, and nothing is deleted.
// Time passing (issue #196): the CVVersion id is in the URL from the moment
// the row exists, so a reload resumes the same Import from the row's status;
// and a Conversion that never ends stops being polled after 3 minutes.

/** The query parameter carrying the CVVersion an Import follows. */
const RESUME_PARAM = "cvVersionId";

/** A Conversion running this long gets a soft line; nothing fails. */
const SLOW_CONVERSION_MS = 45 * 1000;
/** A Conversion running this long stops being polled. */
const CONVERSION_WAIT_CAP_MS = 3 * 60 * 1000;

/** A file's name minus its extension: the label a chosen file suggests. */
function labelFromFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Why a CV file cannot be imported, before any request; null if it can. */
function fileProblem(
  file: File,
  t: ReturnType<typeof useTranslations<"cvVersions">>,
): string | null {
  if (!(file.type in ACCEPTED_CV_CONTENT_TYPES)) return t("form.fileType");
  if (file.size > MAX_CV_SIZE_BYTES) return t("form.fileTooLarge");
  return null;
}

function ImportSteps({ converting }: { converting: boolean }) {
  const t = useTranslations("cvVersions.import");
  const steps = [
    { label: t("step1"), done: converting, active: !converting },
    { label: t("step2"), done: false, active: converting },
    { label: t("step3"), done: false, active: false },
  ];

  return (
    <ol aria-label={t("progressLabel")} className="flex flex-col gap-3">
      {steps.map((step, i) => (
        <li key={i} className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className={cn(
              "flex size-5 flex-none items-center justify-center rounded-full border text-xs",
              step.done
                ? "border-success bg-success text-white"
                : step.active
                  ? "border-foreground text-foreground"
                  : "border-border text-muted",
            )}
          >
            {step.done ? <Check className="size-3" /> : i + 1}
          </span>
          <span
            className={cn(
              "text-sm",
              step.active ? "font-medium" : "text-muted",
            )}
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Success actions: finish, edit, and set-as-default unless it already is. */
function ImportedActions({ cvVersionId }: { cvVersionId: string }) {
  const t = useTranslations("cvVersions");
  const cvVersions = useCvVersions();
  const setDefault = useSetDefaultCvVersion();
  const imported = cvVersions.data?.find((cv) => cv.id === cvVersionId);

  return (
    <div className="flex flex-wrap gap-3">
      <Button asChild>
        <Link href="/cv-versions">
          <Check aria-hidden="true" />
          {t("import.finish")}
        </Link>
      </Button>
      <Button asChild variant="outline">
        <Link href={`/cv-versions/${cvVersionId}/edit`}>
          <Pencil aria-hidden="true" />
          {t("import.edit")}
        </Link>
      </Button>
      {imported && !imported.isDefault && (
        <Button
          type="button"
          variant="outline"
          disabled={setDefault.isPending}
          onClick={() => setDefault.mutate(cvVersionId)}
        >
          {setDefault.isPending ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <Star aria-hidden="true" />
          )}
          {setDefault.isPending
            ? t("list.settingDefault")
            : t("list.setDefault")}
        </Button>
      )}
    </div>
  );
}

/** A failure sentence, with the raw cause (when there is one) underneath. */
function ImportFailure({
  message,
  detail,
  children,
}: {
  message: string;
  detail: string | null | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-md border border-destructive/40 bg-destructive/10 p-4">
      <div role="alert" className="flex flex-col gap-1">
        <p className="text-sm font-medium text-destructive">{message}</p>
        {detail && <p className="text-xs text-muted">{detail}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

/**
 * Storing the CV failed: say which of the three causes, offer a retry. A
 * resumed Import has lost the file with the reload, so its retry
 * (`onRetryWithFile`) asks for the file again instead.
 */
function StoringFailed({
  error,
  retrying,
  fileError,
  onRetry,
  onRetryWithFile,
}: {
  error: CvStoreError;
  retrying: boolean;
  fileError: string | null;
  onRetry: () => void;
  onRetryWithFile: ((file: File) => void) | null;
}) {
  const t = useTranslations("cvVersions.import");

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = firstFile(event.target.files);
    event.target.value = "";
    if (file) onRetryWithFile?.(file);
  }

  return (
    <ImportFailure message={t(`failure.${error.reason}`)} detail={error.detail}>
      {onRetryWithFile ? (
        <label
          className={cn(
            buttonVariants(),
            "cursor-pointer",
            retrying && "pointer-events-none opacity-50",
          )}
        >
          <Upload aria-hidden="true" />
          {t("retryImport")}
          <input
            type="file"
            className="sr-only"
            accept={CV_FILE_ACCEPT}
            disabled={retrying}
            onChange={onFileChange}
          />
        </label>
      ) : (
        <Button type="button" disabled={retrying} onClick={onRetry}>
          {retrying ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <RotateCw aria-hidden="true" />
          )}
          {t("retryImport")}
        </Button>
      )}
      {fileError && (
        <p role="alert" className="w-full text-sm text-destructive">
          {fileError}
        </p>
      )}
    </ImportFailure>
  );
}

/**
 * Converting the CV failed: the file is stored, so retry the Conversion on
 * the same CVVersion or replace its file (replace, PUT, then convert, the
 * same order as docs/adr/0028).
 */
function ConversionFailed({
  detail,
  busy,
  replaceError,
  onRetry,
  onReplace,
}: {
  detail: string | null | undefined;
  busy: boolean;
  replaceError: string | null;
  onRetry: () => void;
  onReplace: (file: File) => void;
}) {
  const t = useTranslations("cvVersions");

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = firstFile(event.target.files);
    event.target.value = "";
    if (file) onReplace(file);
  }

  return (
    <ImportFailure message={t("import.failure.conversion")} detail={detail}>
      <Button type="button" disabled={busy} onClick={onRetry}>
        {busy ? (
          <LoaderCircle className="animate-spin" aria-hidden="true" />
        ) : (
          <RotateCw aria-hidden="true" />
        )}
        {t("import.retryConversion")}
      </Button>
      <label
        className={cn(
          buttonVariants({ variant: "outline" }),
          "cursor-pointer",
          busy && "pointer-events-none opacity-50",
        )}
      >
        <Upload aria-hidden="true" />
        {busy ? t("import.replacing") : t("import.replaceFile")}
        <input
          type="file"
          className="sr-only"
          accept={CV_FILE_ACCEPT}
          disabled={busy}
          onChange={onFileChange}
        />
      </label>
      {replaceError && (
        <p role="alert" className="w-full text-sm text-destructive">
          {replaceError}
        </p>
      )}
    </ImportFailure>
  );
}

type WaitPhase = "waiting" | "slow" | "stalled";

/**
 * How long the Conversion step has been waiting: `slow` after 45 s, then
 * `stalled` after 3 minutes, which is when polling stops. `keepWaiting`
 * starts the clock over. Only counts while `active`.
 */
function useConversionWait(active: boolean) {
  const [round, setRound] = useState(0);
  const [reached, setReached] = useState<{ round: number; phase: WaitPhase }>({
    round: 0,
    phase: "waiting",
  });

  useEffect(() => {
    if (!active) return;
    const slow = setTimeout(
      () => setReached({ round, phase: "slow" }),
      SLOW_CONVERSION_MS,
    );
    const stalled = setTimeout(
      () => setReached({ round, phase: "stalled" }),
      CONVERSION_WAIT_CAP_MS,
    );
    return () => {
      clearTimeout(slow);
      clearTimeout(stalled);
    };
  }, [active, round]);

  const phase: WaitPhase =
    active && reached.round === round ? reached.phase : "waiting";
  return { phase, keepWaiting: () => setRound((r) => r + 1) };
}

/**
 * Progress, then the imported CV, for one CVVersion whose bytes are stored.
 * Mounted once per Conversion attempt (the parent keys it), so the wait caps
 * count from that attempt.
 */
function ImportProgress({
  cvVersionId,
  converting,
  convertError,
  failureActions,
}: {
  cvVersionId: string | null;
  converting: boolean;
  /** The convert request itself failed, after the bytes were stored. */
  convertError: unknown;
  failureActions: Omit<React.ComponentProps<typeof ConversionFailed>, "detail">;
}) {
  const t = useTranslations("cvVersions");
  // Terminal states render ahead of the wait lines, so the clock only needs
  // to know whether the Conversion step has started.
  const wait = useConversionWait(converting);
  const stalled = wait.phase === "stalled";
  const conversion = useCvVersionConversion(converting ? cvVersionId : null, {
    paused: stalled,
  });
  const status = conversion.data?.conversionStatus;

  function keepWaiting() {
    wait.keepWaiting();
    void conversion.refetch();
  }

  if (convertError || status === "FAILED") {
    const detail = convertError
      ? apiErrorDetail(convertError)
      : conversion.data?.conversionError;
    return <ConversionFailed detail={detail} {...failureActions} />;
  }

  if (status === "CONVERTED" && cvVersionId) {
    return (
      <div className="flex flex-col gap-4">
        <p
          role="status"
          className="flex items-center gap-2 text-sm font-medium"
        >
          <Check aria-hidden="true" className="size-4 text-success" />
          {t("import.success")}
        </p>
        <ImportedActions cvVersionId={cvVersionId} />
        <p className="text-xs text-muted">{t("list.markdownRedactionNote")}</p>
        <CvPaper>
          <CvMarkdownContent content={conversion.data?.markdownContent ?? ""} />
        </CvPaper>
      </div>
    );
  }

  const inConversionStep = cvVersionId !== null;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="py-6">
          <div role="status" className="flex flex-col gap-4">
            <ImportSteps converting={inConversionStep} />
            {wait.phase === "slow" && (
              <p className="text-sm text-muted">{t("import.slow")}</p>
            )}
            {stalled && (
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm">{t("import.background")}</p>
                <Button type="button" variant="outline" onClick={keepWaiting}>
                  <Clock aria-hidden="true" />
                  {t("import.keepWaiting")}
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      {inConversionStep && (
        <CvPaper
          role="img"
          aria-label={t("import.skeletonLabel")}
          className="flex flex-col gap-3"
        >
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-4 h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="mt-4 h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </CvPaper>
      )}
    </div>
  );
}

export default function NewCvVersionPage() {
  const t = useTranslations("cvVersions");
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const create = useCreateCvVersion();
  const convert = useConvertCvVersion();
  // The Import screen follows the Conversion itself, see ConversionFailed.
  const replaceFile = useReplaceCvVersion({ startConversion: false });
  // The CVVersion a reload left in the URL, resolved once against the list.
  const [resumeId, setResumeId] = useState(() =>
    searchParams.get(RESUME_PARAM),
  );
  const cvVersions = useCvVersions({ enabled: resumeId !== null });
  // Set once the bytes are stored: the CVVersion this Import follows.
  const [cvVersionId, setCvVersionId] = useState<string | null>(null);
  // Set once convert was accepted (or, on a resume, is known to be running).
  const [following, setFollowing] = useState(false);
  // One per Conversion attempt, so the wait caps count from each attempt.
  const [attempt, setAttempt] = useState(0);
  // What was submitted, kept for a retry or a replace. A resumed Import only
  // has the label: the file went with the reload.
  const [label, setLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  // A resumed row whose upload never finished (FILE_NOT_UPLOADED).
  const [unfinishedUpload, setUnfinishedUpload] = useState<CvStoreError | null>(
    null,
  );
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [retryFileError, setRetryFileError] = useState<string | null>(null);

  const schema = z.object({
    label: z.string().trim().min(1, t("form.labelRequired")),
    file: z
      .any()
      .refine((v) => firstFile(v) !== undefined, t("form.fileRequired"))
      .refine((v) => {
        const f = firstFile(v);
        return !f || f.type in ACCEPTED_CV_CONTENT_TYPES;
      }, t("form.fileType"))
      .refine((v) => {
        const f = firstFile(v);
        return !f || f.size <= MAX_CV_SIZE_BYTES;
      }, t("form.fileTooLarge")),
  });

  const {
    register,
    handleSubmit,
    getValues,
    setValue,
    formState: { errors, isSubmitted },
  } = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { label: "" },
  });

  // The file is the intention, the label a convenience: choosing a file
  // fills the label from its name, but never over text the candidate typed.
  const [labelTyped, setLabelTyped] = useState(false);
  const labelField = register("label", {
    onChange: () => setLabelTyped(true),
  });
  const fileField = register("file", {
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const chosen = firstFile(event.target.files);
      if (!chosen) return;
      if (labelTyped && getValues("label").trim() !== "") return;
      setLabelTyped(false);
      setValue("label", labelFromFileName(chosen.name), {
        shouldValidate: isSubmitted,
      });
    },
  });

  /** A reload resumes this Import; replacing keeps a single history entry. */
  function followInUrl(id: string | null) {
    router.replace(
      id ? `/cv-versions/new?${RESUME_PARAM}=${id}` : "/cv-versions/new",
    );
  }

  /** The file first, the Conversion second (docs/adr/0028). */
  function startConversion(id: string) {
    // A retry must not read the previous attempt's terminal status.
    queryClient.removeQueries({ queryKey: ["cv-versions", id, "markdown"] });
    setFollowing(false);
    setAttempt((n) => n + 1);
    convert.mutate(id, { onSuccess: () => setFollowing(true) });
  }

  // Resume: look the CVVersion up once, then pick up from its status. An
  // unknown, foreign (absent from this user's list) or superseded one falls
  // back to a blank form. Resolved while rendering; the effect below only
  // does what reaches outside (the URL, the convert request).
  const [resumed, setResumed] = useState<{
    id: string | null;
    pending: boolean;
  } | null>(null);
  if (resumeId !== null && !cvVersions.isPending) {
    const row = cvVersions.data?.find((cv) => cv.id === resumeId);
    const usable = row && row.supersededById === null ? row : null;
    setResumeId(null);
    setResumed({
      id: usable?.id ?? null,
      pending: usable?.conversionStatus === "PENDING",
    });
    if (usable) {
      setLabel(usable.label);
      setCvVersionId(usable.id);
      setFollowing(usable.conversionStatus !== "PENDING");
    }
  }

  // StrictMode re-runs effects; the resume's convert must go out once.
  const resumeSent = useRef(false);
  useEffect(() => {
    if (resumed === null || resumeSent.current) return;
    resumeSent.current = true;
    if (resumed.id === null) {
      followInUrl(null);
      return;
    }
    if (!resumed.pending) return;
    const id = resumed.id;
    // PENDING after a reload: either the Conversion is queued, or the reload
    // aborted the PUT and nothing will ever advance the row. Convert tells
    // the two apart (the #193 guard); anything but FILE_NOT_UPLOADED means
    // there is a Conversion to follow.
    convert.mutate(id, {
      onSettled: (_data, error) => {
        if (apiErrorCode(error) === "FILE_NOT_UPLOADED") {
          setUnfinishedUpload(
            new CvStoreError("upload", null, {
              cvVersionId: id,
              fileKey: "",
              uploadUrl: "",
              // Its upload URL went with the reload: always expired.
              createdAt: 0,
            }),
          );
        } else {
          convert.reset();
          setFollowing(true);
        }
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on resolution
  }, [resumed]);

  function store(
    values: { label: string; file: File },
    previous: CvStoreError["created"] = null,
  ) {
    setUnfinishedUpload(null);
    create.mutate(
      {
        ...values,
        previous,
        onCreated: (created) => followInUrl(created.cvVersionId),
      },
      {
        onSuccess: (created) => {
          setCvVersionId(created.cvVersionId);
          startConversion(created.cvVersionId);
        },
      },
    );
  }

  const onSubmit = handleSubmit((values) => {
    const chosen = firstFile(values.file);
    if (!chosen) return;
    const trimmed = values.label.trim();
    setLabel(trimmed);
    setFile(chosen);
    store({ label: trimmed, file: chosen });
  });

  const storeError =
    unfinishedUpload ??
    (create.error instanceof CvStoreError ? create.error : null);

  function retryStore() {
    if (file) store({ label, file }, storeError?.created);
  }

  function retryStoreWithFile(chosen: File) {
    const problem = fileProblem(chosen, t);
    setRetryFileError(problem);
    if (problem) return;
    setFile(chosen);
    store({ label, file: chosen }, storeError?.created);
  }

  function replaceConvertedFile(chosen: File) {
    if (!cvVersionId) return;
    const problem = fileProblem(chosen, t);
    setReplaceError(problem);
    if (problem) return;
    replaceFile.mutate(
      { id: cvVersionId, label, file: chosen },
      {
        onSuccess: (created) => {
          setCvVersionId(created.cvVersionId);
          followInUrl(created.cvVersionId);
          startConversion(created.cvVersionId);
        },
        onError: () => setReplaceError(t("import.failure.upload")),
      },
    );
  }

  // Only a storing failure leaves a row with no file behind it; only the
  // explicit close discards it — never on unmount or beforeunload, which
  // also fire on a StrictMode double-mount or HMR and guarantee nothing.
  function onClose() {
    if (storeError?.created) discardCvVersion(storeError.created.cvVersionId);
  }

  const importing =
    resumeId !== null || create.isPending || cvVersionId !== null;

  return (
    <main
      className={cn("mx-auto flex w-full flex-col gap-6 p-8", CV_PAGE_COLUMN_CLASS)}
    >
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-serif text-2xl font-semibold">
          {t("form.heading")}
        </h1>
        <Button asChild variant="ghost">
          <Link href="/cv-versions" onClick={onClose}>
            <X aria-hidden="true" />
            {t("import.close")}
          </Link>
        </Button>
      </div>

      {storeError ? (
        <StoringFailed
          error={storeError}
          retrying={create.isPending}
          fileError={retryFileError}
          onRetry={retryStore}
          onRetryWithFile={file ? null : retryStoreWithFile}
        />
      ) : importing ? (
        <ImportProgress
          key={`${cvVersionId}:${attempt}`}
          cvVersionId={cvVersionId}
          converting={following}
          convertError={convert.error}
          failureActions={{
            busy: convert.isPending || replaceFile.isPending,
            replaceError,
            onRetry: () => cvVersionId && startConversion(cvVersionId),
            onReplace: replaceConvertedFile,
          }}
        />
      ) : (
        <Card>
          <CardContent className="py-6">
            <form
              className="flex flex-col gap-4"
              onSubmit={onSubmit}
              noValidate
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cv-file">{t("form.fileLabel")}</Label>
                <Input
                  id="cv-file"
                  type="file"
                  accept={CV_FILE_ACCEPT}
                  aria-invalid={errors.file ? true : undefined}
                  aria-describedby="cv-file-hint"
                  {...fileField}
                />
                <p id="cv-file-hint" className="text-xs text-muted">
                  {t("form.fileHint")}
                </p>
                {errors.file && (
                  <p role="alert" className="text-sm text-destructive">
                    {errors.file.message as string}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cv-label">{t("form.labelLabel")}</Label>
                <Input
                  id="cv-label"
                  type="text"
                  placeholder={t("form.labelPlaceholder")}
                  aria-invalid={errors.label ? true : undefined}
                  {...labelField}
                />
                {errors.label && (
                  <p role="alert" className="text-sm text-destructive">
                    {errors.label.message}
                  </p>
                )}
              </div>

              <Button type="submit" className="self-start">
                <Upload aria-hidden="true" />
                {t("form.submit")}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
