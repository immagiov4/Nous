import { IMAGE_CREDIT_FONT_PX, IMAGE_CREDIT_LINE_PX } from '@shared/lessonStudios/imageAnnotate';
import { imageAnnotateCopy as copy } from '@shared/lessonStudios/imageAnnotate.copy.it';
import type { ImageAnnotateSpec } from '@shared/lessonStudios/imageAnnotateSpec';
import { useId, useState } from 'react';
import { translateUiMessage as t } from '../../../../i18n/uiMessages.ts';
import './imageAnnotation.css';

export function ImageAnnotationCredit({ image }: { image: ImageAnnotateSpec['image'] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const author = image.attribution || image.author;
  const license = image.license === 'Public domain' ? copy.publicDomain : image.license;
  return (
    <div
      className="image-annotation-credit"
      style={{
        fontSize: `calc(${IMAGE_CREDIT_FONT_PX}px / var(--scene-scale, 1))`,
        lineHeight: `calc(${IMAGE_CREDIT_LINE_PX}px / var(--scene-scale, 1))`,
      }}
    >
      <button
        aria-controls={panelId}
        aria-expanded={open}
        aria-label={copy.fullCredit}
        className="image-annotation-credit-button"
        type="button"
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        {author ? <span className="image-annotation-credit-author">{author}</span> : null}
        <span>
          {author ? ' · ' : ''}
          {license} · {copy.commons}
        </span>
      </button>
      <div id={panelId} className="image-annotation-credit-panel" data-open={open || undefined}>
        <a href={image.source} target="_blank" rel="noreferrer">
          {image.title} · {copy.commons}
        </a>
        {author ? <span>{author}</span> : null}
        {image.author && image.author !== author ? <span>{image.author}</span> : null}
        {image.credit && image.credit !== author ? <span>{image.credit}</span> : null}
        {image.licenseUrl ? (
          <a href={image.licenseUrl} target="_blank" rel="noreferrer">
            {license}
          </a>
        ) : (
          <span>{license}</span>
        )}
        <span>{copy.annotated}</span>
      </div>
    </div>
  );
}

export function UnavailableAnnotation() {
  return (
    <output className="image-annotation-unavailable">{t('Esempio visuale non disponibile')}</output>
  );
}
