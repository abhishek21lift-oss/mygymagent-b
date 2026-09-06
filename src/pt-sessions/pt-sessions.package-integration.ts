// PT package consumption is intentionally isolated from the session controller.
// The package service exposes the transactional consumption primitive used by
// the PT session completion flow. This file documents the integration seam
// for future domain-event consumers without introducing duplicate behavior.
export const PT_PACKAGE_CONSUMPTION_INTEGRATION =
  'PtPackagesService.consumeForCompletedSession';
