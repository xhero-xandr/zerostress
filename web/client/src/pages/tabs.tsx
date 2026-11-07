// The five sections of a report. Every string that came from the page, the network or the model is rendered as a text
// node (React escapes it) and never becomes an address, a style or markup.
import { useState } from 'react';
import type { PublicReport } from '../../../agent/report-types.ts';
import { shotUrl, type TaskStatus } from '../api.ts';
import { agentLines, ageWords, confidenceWord, countryName, deadLinks, devicesSummary, findings, injectionText, redirects, seriousCount, serversLine, verdictLine } from '../logic.ts';
import { ShotViewer } from '../shot-viewer.tsx';
import { T } from '../text.ts';
import { SecondOpinion } from './second-opinion.tsx';
import { Card, Fact, Facts, LevelPill, Notice, TableWrap, Td, Th, VERDICT_STYLE } from '../ui.tsx';

type R = { r: PublicReport };
const SHOT_SIZE = { desktop: 'w-full max-w-[420px] aspect-[1280/800]', tablet: 'w-[220px] aspect-[820/1180]', mobile: 'w-[160px] aspect-[412/839]' } as const;
type Device = keyof typeof SHOT_SIZE;

function VerdictCard({ r }: R) {
  const v = VERDICT_STYLE[r.verdict];
  return (
    <section aria-labelledby="verdict" className={`flex flex-col gap-3.5 rounded-2xl border bg-surface p-5 sm:p-6 ${v.border}`}>
      <div className="flex flex-wrap items-center gap-3.5">
        <span className={`flex size-13 flex-none items-center justify-center rounded-2xl ${v.tile}`}><v.Icon className="size-7" aria-hidden /></span>
        <div className="flex flex-col gap-0.5">
          <h1 id="verdict" className={`text-3xl leading-tight font-extrabold ${v.text}`}>{T.verdict[r.verdict]}</h1>
          {r.verdict !== 'unknown' && <span className="text-[15px] text-muted">{confidenceWord(r.confidence)}</span>}
        </div>
      </div>
      <p className="text-[17px] leading-relaxed">{verdictLine(r)}</p>
    </section>
  );
}

function FindingsCard({ r }: R) {
  const list = findings(r);
  return (
    <Card title={T.findingsTitle} titleId="findings">
      {list.length ? (
        <ul className="flex flex-col">
          {list.map((s, i) => (
            <li key={`${s.id}-${i}`} className="flex gap-3.5 border-t border-line py-3.5 first:border-t-0 first:pt-0">
              <LevelPill level={s.level}>{T.level[s.level] ?? T.level.info}</LevelPill>
              <span className="min-w-0 [overflow-wrap:anywhere]">{s.text}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-muted">{T.noFindings}</p>}
    </Card>
  );
}

function ExplanationCard({ r }: R) {
  const text = r.summary ?? r.mode_text;
  if (!text) return null;
  return (
    <Card title={T.explainTitle} titleId="explanation">
      <p className="leading-relaxed [overflow-wrap:anywhere]">{text}</p>
      {r.reasons.length > 0 && <ul className="mt-3 list-disc pl-5 text-muted">{r.reasons.map((x, i) => <li key={i} className="[overflow-wrap:anywhere]">{x.claim}</li>)}</ul>}
    </Card>
  );
}

function Screenshot({ id, shots }: { id: string; shots: TaskStatus['shots'] }) {
  const have = (['desktop', 'tablet', 'mobile'] as const).filter((d) => shots[d]);
  const [device, setDevice] = useState<Device>(have[0] ?? 'desktop');
  return (
    <section aria-labelledby="shot" className="flex flex-col gap-3.5 rounded-2xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <h2 id="shot" className="font-bold">{T.screenshotTitle}</h2>
        {have.length > 1 && (
          <div role="group" aria-label={T.shotSwitch} className="inline-flex gap-0.5 rounded-xl bg-sunken p-[3px]">
            {have.map((d) => (
              <button key={d} type="button" aria-pressed={device === d} onClick={() => setDevice(d)}
                className={`h-8.5 rounded-lg px-3 text-sm font-medium ${device === d ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg'}`}>
                {T.device[d]}
              </button>
            ))}
          </div>
        )}
      </div>
      {have.length ? (
        <div className="flex justify-center rounded-xl border border-dashed border-line-strong bg-sunken p-3">
          <ShotViewer src={shotUrl(id, device)} alt={T.screenshotAlt(T.device[device]!)} className={SHOT_SIZE[device]}>
            <img src={shotUrl(id, device)} alt={T.screenshotAlt(T.device[device]!)} className="h-full w-full rounded-lg border border-line bg-surface object-cover object-top" />
          </ShotViewer>
        </div>
      ) : <p className="text-muted">{T.noScreenshot}</p>}
      <span className="text-[13px] text-faint">{T.screenshotNote}</span>
    </section>
  );
}

function DevicesCard({ r }: R) {
  const summary = devicesSummary(r);
  if (summary === null) return null;
  return (
    <Card title={T.devicesTitle} titleId="devices">
      <p className="mb-3 leading-relaxed">{summary}</p>
      <TableWrap>
        <thead><tr><Th>{T.devicesHead.device}</Th><Th>{T.devicesHead.site}</Th><Th>{T.devicesHead.password}</Th><Th>{T.devicesHead.note}</Th></tr></thead>
        <tbody>
          {r.facts.devices.map((d) => (
            <tr key={d.device}>
              <Td>{T.device[d.device]}</Td>
              <Td mono>{d.nav_error ? '—' : d.final_host}{d.title && <><br /><span className="font-sans text-[13px] text-faint">{d.title}</span></>}</Td>
              <Td>{d.nav_error ? '—' : d.has_password ? T.yes : T.no}</Td>
              <Td>{d.nav_error ? T.devicesNotOpened : d.differs.length ? d.differs.map((x) => T.differs[x]).join(' ') : T.devicesAlike}</Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </Card>
  );
}

function DomainCard({ r }: R) {
  const d = r.facts.domain;
  return (
    <Card title={T.domainTitle} titleId="domain">
      {d ? (
        <Facts>
          <Fact term={T.rows.domain} mono>{d.name}</Fact>
          <Fact term={T.rows.registered}>
            {d.created ? <>{d.created.slice(0, 10)}{d.age_days !== null && <span className="text-muted"> ({ageWords(d.age_days)})</span>}{d.age_days !== null && d.age_days < 30 && <> <LevelPill level="medium">{T.domainNew}</LevelPill></>}</> : '—'}
          </Fact>
          {d.registrar && <Fact term={T.domainRegistrar}>{d.registrar}</Fact>}
        </Facts>
      ) : <p className="text-muted">{T.domainUnknown}</p>}
    </Card>
  );
}

export function Summary({ r, status }: R & { status: TaskStatus }) {
  const f = r.facts;
  const serious = seriousCount(r);
  return (
    <div className="flex flex-wrap items-start gap-5">
      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-5">
        <VerdictCard r={r} />
        <SecondOpinion r={r} id={status.id} />
        <FindingsCard r={r} />
        <ExplanationCard r={r} />
        <Card title={T.glanceTitle} titleId="glance">
          <Facts>
            <Fact term={T.rows.host} mono>{f.final_host || '—'}</Fact>
            <Fact term={T.rows.title}>{f.page_title || '—'}</Fact>
            <Fact term={T.rows.domain}>{f.domain?.age_days != null ? `${T.rows.registered} ${ageWords(f.domain.age_days)}` : '—'}</Fact>
            <Fact term={T.findingsTitle}>{serious ? `${serious} serious or moderate` : T.formNone}</Fact>
            <Fact term={T.rows.requests}>{`${f.requests_total}, to ${f.third_party_hosts} other sites`}</Fact>
            <Fact term={T.rows.redirects}>{redirects(r)}</Fact>
            <Fact term={T.rows.cert}>{f.tls.length ? `${f.tls.length} recorded` : T.formNone}</Fact>
            <Fact term={T.rows.forms}>{f.forms.length ? T.formsText(f.forms.length, f.forms.filter((x) => x.has_password).length, f.forms.filter((x) => x.cross_origin).length) : T.formNone}</Fact>
          </Facts>
          <p className="mt-4 text-[15px] text-muted">{T.sumLine(f.third_party_hosts, f.requests_total)}</p>
        </Card>
      </div>
      <aside aria-label={T.screenshotTitle} className="flex min-w-0 flex-[1_1_380px] flex-col gap-5">
        <Screenshot id={status.id} shots={status.shots} />
        {devicesSummary(r) !== null && (
          <section aria-labelledby="devices-short" className="flex flex-col gap-2.5 rounded-2xl border border-line bg-surface p-5">
            <h2 id="devices-short" className="font-bold">{T.devicesTitle}</h2>
            <p className="text-sm leading-relaxed text-muted">{devicesSummary(r)}</p>
          </section>
        )}
      </aside>
    </div>
  );
}

export function Security({ r }: R) {
  const f = r.facts;
  return (
    <div className="flex flex-col gap-5">
      <VerdictCard r={r} />
      <FindingsCard r={r} />
      <DomainCard r={r} />
      <DevicesCard r={r} />
      <Card title={T.certsTitle} titleId="certs">
        {f.tls.length ? (
          <div className="flex flex-col gap-4">
            {f.tls.map((c, i) => (
              <Facts key={i}>
                <Fact term={T.rows.site} mono>{c.host || '—'}</Fact>
                <Fact term={T.rows.issuer}>{c.issuer || '—'}</Fact>
                <Fact term={T.rows.validUntil}>{c.valid_to ? c.valid_to.slice(0, 10) : '—'}</Fact>
              </Facts>
            ))}
          </div>
        ) : <p className="text-muted">{T.noCerts}</p>}
      </Card>
      <Card title={T.rows.forms} titleId="forms">
        {f.forms.length ? (
          <>
            <p className="mb-3">{T.formsText(f.forms.length, f.forms.filter((x) => x.has_password).length, f.forms.filter((x) => x.cross_origin).length)}</p>
            <ul className="flex flex-col gap-3">
              {f.forms.map((x, i) => (
                <li key={i} className="[overflow-wrap:anywhere]">
                  {x.has_password ? T.formPassword : T.formPlain}
                  {x.action_host && <> → <span className="font-mono">{x.action_host}</span></>}
                  {x.cross_origin && <> <LevelPill level="high">{T.otherSite}</LevelPill></>}
                  {x.asks.length > 0 && <><br /><span className="text-sm text-faint">{T.formAsks}: {x.asks.map((a) => T.ask[a] ?? a).join(', ')}</span></>}
                </li>
              ))}
            </ul>
          </>
        ) : <p className="text-muted">{T.formNone}</p>}
      </Card>
      {r.injection_attempt && <Notice>{injectionText(r)}</Notice>}
    </div>
  );
}

export function Network({ r }: R) {
  const f = r.facts;
  return (
    <div className="flex flex-col gap-5">
      <Card title={T.pathTitle} titleId="path">
        {f.chain.length ? (
          <ol className="flex flex-col gap-2">
            {f.chain.map((c, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="w-36 flex-none text-sm text-faint">{T.pathVia[c.via] ?? T.pathViaOther}</span>
                <span className="min-w-0 font-mono [overflow-wrap:anywhere]">{c.host}</span>
              </li>
            ))}
          </ol>
        ) : <p className="text-muted">—</p>}
      </Card>
      <Card title={T.serversTitle} titleId="servers">
        {f.servers.length ? (
          <>
            <p className="mb-3">{serversLine(r)}</p>
            <TableWrap>
              <thead><tr><Th>{T.serversHead.ip}</Th><Th>{T.serversHead.place}</Th><Th>{T.serversHead.net}</Th><Th>{T.serversHead.sites}</Th><Th>{T.serversHead.req}</Th></tr></thead>
              <tbody>
                {f.servers.map((x) => (
                  <tr key={x.ip}>
                    <Td mono nowrap>{x.ip}</Td>
                    <Td>{countryName(x.country)}</Td>
                    <Td>{x.asn !== null ? `AS${x.asn}` : '—'}{x.org && <><br /><span className="text-[13px] text-faint">{x.org}</span></>}</Td>
                    <Td mono>{x.hosts.join(', ') || '—'}</Td>
                    <Td>{x.requests}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            {f.servers_total > f.servers.length && <p className="mt-2 text-[13px] text-faint">{T.serversMore(f.servers_total - f.servers.length)}</p>}
            <p className="mt-2 text-[13px] text-faint">{T.serversNote} {f.servers.some((x) => x.country !== null) ? T.attribution : ''}</p>
          </>
        ) : <p className="text-muted">{T.serversNone}</p>}
      </Card>
      <Card title={T.sitesTitle} titleId="sites">
        <p className="mb-3">{T.sumLine(f.third_party_hosts, f.requests_total)}</p>
        {f.hosts.length ? <ul className="flex flex-wrap gap-2">{f.hosts.map((h) => <li key={h} className="rounded-lg bg-sunken px-2.5 py-1 font-mono text-sm [overflow-wrap:anywhere]">{h}</li>)}</ul> : <p className="text-muted">{T.noOtherSites}</p>}
        {f.third_party_hosts > f.hosts.length && <p className="mt-2 text-[13px] text-faint">{T.andMore(f.third_party_hosts - f.hosts.length)}</p>}
      </Card>
      <Card title={T.sandboxTitle} titleId="sandbox">
        <Facts><Fact term={T.rows.blocked}>{f.blocked_requests}</Fact></Facts>
        <p className="mt-3 text-muted">{T.sandboxNote}</p>
      </Card>
    </div>
  );
}

export function Links({ r }: R) {
  const f = r.facts;
  const dead = deadLinks(r);
  return (
    <Card title={T.linksTitle} titleId="links">
      {f.links.length ? (
        <div className="flex flex-col gap-3">
          <TableWrap>
            <thead><tr><Th>{T.linkText}</Th><Th>{T.linkGoes}</Th></tr></thead>
            <tbody>
              {f.links.map((l, i) => (
                <tr key={i}>
                  <Td>{l.text || '—'}</Td>
                  <Td mono>
                    {l.goes === 'nowhere' ? T.goesNowhere : l.goes === 'same' ? T.goesSame : l.host || '—'}
                    {l.other_site && <> <LevelPill level="medium">{T.linkOtherSite}</LevelPill></>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          {dead && <Notice>{T.linksNowhere(dead.nowhere, dead.total)}</Notice>}
          <p className="text-[13px] text-faint">{T.linksNote}</p>
        </div>
      ) : <p className="text-muted">{T.noLinks}</p>}
    </Card>
  );
}

export function Behavior({ r }: R) {
  const f = r.facts;
  return (
    <div className="flex flex-col gap-5">
      <Card title={T.behaviorTitle} titleId="behavior">
        <Facts>
          <Fact term={T.rows.hidden}>{f.hidden_text ? <LevelPill level="medium">{T.yes}</LevelPill> : T.no}</Fact>
          <Fact term={T.rows.popups}>{f.popups ? <LevelPill level="medium">{String(f.popups)}</LevelPill> : T.no}</Fact>
          <Fact term={T.rows.dialogs}>{f.dialogs ? <LevelPill level="medium">{String(f.dialogs)}</LevelPill> : T.no}</Fact>
          <Fact term={T.rows.downloads}>
            {f.downloads.length ? <ul>{f.downloads.map((d, i) => <li key={i} className="font-mono">{d.filename || '—'}{d.saved ? '' : ` (${T.notSaved})`}</li>)}</ul> : T.no}
          </Fact>
        </Facts>
      </Card>
      <Card title={T.agentTitle} titleId="agent">
        <ol className="flex flex-col gap-2 border-l-2 border-line pl-4">
          {agentLines(r).map((l, i) => <li key={i} className="[overflow-wrap:anywhere]">{l}</li>)}
        </ol>
      </Card>
    </div>
  );
}
