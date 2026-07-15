import React from 'react';
import { MissingAnnotationEmptyState } from '@backstage/plugin-catalog-react';
import { ANNOTATION_K8S_NAMESPACE } from './useMeteringData';

/**
 * Shown when the entity is missing the annotation the metering backend needs
 * to look up Kubernetes resource usage. Uses the same component the
 * Kubernetes plugin uses for its own missing-annotation state, for a
 * consistent look and feel (and automatic dark mode support).
 */
export function MeteringAnnotationGuard() {
  return <MissingAnnotationEmptyState annotation={ANNOTATION_K8S_NAMESPACE} />;
}
