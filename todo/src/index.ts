// Re-export the community todo plugin as a dynamic plugin for RHDH. 
// This thin wrapper allows the community plugin to be packaged as an OCI image
// and loaded dynamically by RHDH without modifying any source code. 
export * from '@backstage-community/plugin-todo';
