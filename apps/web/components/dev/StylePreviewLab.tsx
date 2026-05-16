import { ArrowLeft, ChevronRight } from 'lucide-react';
import type { IconType } from 'react-icons';
import {
  HiOutlineAcademicCap,
  HiOutlineBookOpen,
  HiOutlineCog6Tooth,
  HiOutlineDocumentText,
  HiOutlineMoon,
  HiOutlineSpeakerWave,
  HiOutlineSquares2X2,
} from 'react-icons/hi2';
import {
  LuBookOpen,
  LuFileText,
  LuGraduationCap,
  LuLayoutGrid,
  LuMoon,
  LuRoute,
  LuSettings2,
  LuVolume2,
} from 'react-icons/lu';
import {
  PiBookOpenText,
  PiCompassTool,
  PiFileText,
  PiMoonStars,
  PiPath,
  PiSpeakerHigh,
  PiStudent,
  PiTabs,
  PiWrench,
} from 'react-icons/pi';
import logoUrl from '@/assets/logo.svg';

type IconSet = {
  course: IconType;
  lesson: IconType;
  note: IconType;
  path: IconType;
  section: IconType;
  settings: IconType;
  theme: IconType;
  voice: IconType;
};

type PreviewVariant = {
  badgeClassName: string;
  frameClassName: string;
  iconSet: IconSet;
  id: string;
  label: string;
  note: string;
  shellClassName: string;
  sourceLabel: string;
};

const PREVIEW_VARIANTS: PreviewVariant[] = [
  {
    id: 'lucide',
    label: 'Lucide',
    sourceLabel: 'Set reale: lucide-react',
    note: 'Pulito, leggero, molto neutro. Probabilmente il più leggibile, ma anche il più “già visto”.',
    shellClassName: 'bg-[#faf6f0] text-[#211d19]',
    badgeClassName: 'border border-[#d8d3ca] bg-[#f2eee8] text-[#5a534b]',
    frameClassName: 'rounded-[1rem] border border-[#d8d1c6] bg-white text-[#38332d]',
    iconSet: {
      course: LuGraduationCap,
      lesson: LuBookOpen,
      note: LuFileText,
      path: LuRoute,
      section: LuLayoutGrid,
      settings: LuSettings2,
      theme: LuMoon,
      voice: LuVolume2,
    },
  },
  {
    id: 'phosphor',
    label: 'Phosphor',
    sourceLabel: 'Set reale: Phosphor via react-icons',
    note: 'Più morbido e amichevole. Ha più personalità senza sembrare giocattoloso.',
    shellClassName: 'bg-[#faf4ec] text-[#221b16]',
    badgeClassName: 'border border-[#e8c8a4] bg-[#fdf0e0] text-[#915927]',
    frameClassName: 'rounded-full border border-[#e5c3a0] bg-[#fffaf4] text-[#8a5628]',
    iconSet: {
      course: PiStudent,
      lesson: PiBookOpenText,
      note: PiFileText,
      path: PiPath,
      section: PiTabs,
      settings: PiWrench,
      theme: PiMoonStars,
      voice: PiSpeakerHigh,
    },
  },
  {
    id: 'heroicons',
    label: 'Heroicons',
    sourceLabel: 'Set reale: Heroicons via react-icons',
    note: 'Più deciso e accademico. Meno caldo, ma più “prodotto curato” e meno commodity di Lucide.',
    shellClassName: 'bg-[#f7f3ed] text-[#1f1a15]',
    badgeClassName: 'border border-[#d8d0c4] bg-[#efe9df] text-[#534a3f]',
    frameClassName: 'rounded-[0.85rem] border border-[#d6cec3] bg-white text-[#302b25]',
    iconSet: {
      course: HiOutlineAcademicCap,
      lesson: HiOutlineBookOpen,
      note: HiOutlineDocumentText,
      path: PiCompassTool,
      section: HiOutlineSquares2X2,
      settings: HiOutlineCog6Tooth,
      theme: HiOutlineMoon,
      voice: HiOutlineSpeakerWave,
    },
  },
];

function IconTile({
  Icon,
  frameClassName,
  label,
}: {
  Icon: IconType;
  frameClassName: string;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className={`inline-flex h-10 w-10 items-center justify-center ${frameClassName}`}>
        <Icon aria-hidden className="h-[18px] w-[18px]" />
      </span>
      <span className="text-sm">{label}</span>
    </div>
  );
}

function PreviewVariantCard({ variant }: { variant: PreviewVariant }) {
  const { iconSet } = variant;

  return (
    <article className="rounded-[2rem] border border-gray-200 bg-white p-5 shadow-[0_24px_80px_-48px_rgba(24,24,27,0.45)]">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">
            {variant.label}
          </p>
          <p className="mt-1 text-xs font-medium text-gray-500">{variant.sourceLabel}</p>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600">{variant.note}</p>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${variant.badgeClassName}`}
        >
          Icon Set
        </span>
      </div>

      <div
        className={`overflow-hidden rounded-[1.7rem] border border-black/5 ${variant.shellClassName}`}
      >
        <div className="flex items-center justify-between border-b border-black/8 px-4 py-3">
          <div className="flex items-center gap-3">
            <img src={logoUrl} alt="Nous" className="h-8 w-8 object-contain" />
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] opacity-55">
                Nous Reader
              </p>
              <h3 className="font-serif text-2xl leading-none tracking-[-0.03em]">Dati e reti</h3>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {[
              { key: 'voice', Icon: iconSet.voice },
              { key: 'settings', Icon: iconSet.settings },
              { key: 'theme', Icon: iconSet.theme },
            ].map(({ key, Icon }) => (
              <span
                key={`${variant.id}-toolbar-${key}`}
                className={`inline-flex h-10 w-10 items-center justify-center ${variant.frameClassName}`}
              >
                <Icon aria-hidden className="h-[18px] w-[18px]" />
              </span>
            ))}
          </div>
        </div>

        <div className="grid gap-0 border-t border-black/5 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <aside className="border-r border-black/5 px-4 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] opacity-50">
              Sidebar
            </p>
            <div className="mt-4 space-y-3">
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-[1.1rem] bg-white/65 px-3 py-3 text-left"
              >
                <span
                  className={`inline-flex h-10 w-10 items-center justify-center ${variant.frameClassName}`}
                >
                  <iconSet.path aria-hidden className="h-[18px] w-[18px]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">Commutazione</span>
                  <span className="block truncate text-xs opacity-60">Lezione attiva</span>
                </span>
              </button>

              <IconTile
                Icon={iconSet.course}
                frameClassName={variant.frameClassName}
                label="Instradamento"
              />
              <IconTile
                Icon={iconSet.lesson}
                frameClassName={variant.frameClassName}
                label="Affidabilita"
              />
              <IconTile
                Icon={iconSet.note}
                frameClassName={variant.frameClassName}
                label="Ripasso e note"
              />
            </div>
          </aside>

          <section className="px-5 py-5">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] opacity-55">
              <span
                className={`inline-flex items-center rounded-full px-3 py-1 ${variant.badgeClassName}`}
              >
                Pausa attiva
              </span>
              <span className="opacity-60">Lezione 2</span>
            </div>

            <h4 className="mt-4 font-serif text-[2rem] leading-[1.02] tracking-[-0.03em]">
              Dal messaggio al percorso
            </h4>

            <div className="mt-5 max-w-[62ch] space-y-4 text-[1.02rem] leading-8 opacity-92">
              <p>
                Quando una rete deve portare dei dati da una stazione sorgente a una stazione
                destinataria, non basta dire che i dati passano nella rete.
              </p>
              <p>
                Bisogna anche stabilire <strong>quale strada devono seguire</strong>. Questa scelta
                del percorso e il nucleo della commutazione.
              </p>
            </div>

            <div className="mt-8 grid gap-4 border-t border-black/8 pt-4 lg:grid-cols-[minmax(0,1fr)_15rem]">
              <div>
                <p className="text-sm opacity-65">
                  Stessi font, stesso layout: qui cambia solo il set iconografico.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-4">
                  <IconTile
                    Icon={iconSet.path}
                    frameClassName={variant.frameClassName}
                    label="Percorso"
                  />
                  <IconTile
                    Icon={iconSet.note}
                    frameClassName={variant.frameClassName}
                    label="Note"
                  />
                  <IconTile
                    Icon={iconSet.voice}
                    frameClassName={variant.frameClassName}
                    label="Audio"
                  />
                  <IconTile
                    Icon={iconSet.section}
                    frameClassName={variant.frameClassName}
                    label="Sezioni"
                  />
                </div>
              </div>

              <div className="flex items-end justify-start lg:justify-end">
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-full border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800"
                >
                  Prosegui <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </article>
  );
}

export default function StylePreviewLab() {
  return (
    <main className="min-h-screen bg-[#faf7f2] px-4 py-6 text-gray-900 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">
              Temporary Style Lab
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-gray-900">
              Iconografia di prova
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-600">
              Qui ora ci sono set reali, non disegnati a mano. Apri <code>#style-lab</code> e
              confronta Lucide, Phosphor e Heroicons sugli stessi punti della UI.
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              window.location.hash = '';
            }}
            className="inline-flex items-center gap-2 rounded-full border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-gray-400 hover:text-gray-900"
          >
            <ArrowLeft className="h-4 w-4" />
            Torna all'app
          </button>
        </div>

        <div className="mb-5 rounded-[1.6rem] border border-gray-200 bg-white px-5 py-4 text-sm leading-6 text-gray-600">
          Il confronto adesso è reale:
          <strong> Lucide</strong>, <strong>Phosphor</strong> e <strong>Heroicons</strong>. Se una
          famiglia ti convince più delle altre, la posso poi applicare davvero alla UI reale nei
          punti chiave.
        </div>

        <div className="grid gap-5">
          {PREVIEW_VARIANTS.map(variant => (
            <PreviewVariantCard key={variant.id} variant={variant} />
          ))}
        </div>
      </div>
    </main>
  );
}
