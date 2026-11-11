import Link from "next/link";
import { Chevron } from "./Icons";

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`card p-5 ${className}`}>{children}</section>;
}

export function CardHeader({
  icon,
  title,
  color,
  meta,
  href,
}: {
  icon: React.ReactNode;
  title: string;
  color: string;
  meta?: React.ReactNode;
  href?: string;
}) {
  const right = (
    <span className="flex items-center gap-1 text-[13px] text-muted">
      {meta}
      {href && <Chevron size={14} />}
    </span>
  );
  return (
    <div className="mb-3 flex items-center justify-between">
      <span className="flex items-center gap-1.5 text-[15px] font-semibold" style={{ color }}>
        {icon}
        {title}
      </span>
      {href ? (
        <Link href={href} className="hover:opacity-70">
          {right}
        </Link>
      ) : (
        right
      )}
    </div>
  );
}

export function BigValue({ value, unit, className = "" }: { value: React.ReactNode; unit?: string; className?: string }) {
  return (
    <div className={`tabular flex items-baseline gap-1 ${className}`}>
      <span className="text-[34px] font-semibold leading-none tracking-tight">{value}</span>
      {unit && <span className="text-[15px] font-medium text-muted">{unit}</span>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-fill ${className}`} />;
}

export function PageTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="pb-5 pt-8">
      {subtitle && <p className="text-[13px] font-semibold uppercase tracking-wide text-muted">{subtitle}</p>}
      <h1 className="text-[34px] font-bold tracking-tight">{title}</h1>
    </div>
  );
}
