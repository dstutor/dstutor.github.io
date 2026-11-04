// The polars gallery: src/data/examples.json, validated by @dstutor/notebook-ui.
import { loadGallery } from '@dstutor/notebook-ui';
import data from './data/examples.json';

export const gallery = loadGallery(data);
export const { examples, categories, getExampleById } = gallery;
