import { google } from '@ai-sdk/google';
import { GoogleGenerativeAIProviderMetadata } from '@ai-sdk/google';
import { generateText } from 'ai';

async function main() {
  const { text, sources, providerMetadata } = await generateText({
    model: google('gemini-3-flash-preview'),
    tools: {
      google_search: google.tools.googleSearch({}),
    },
    prompt:
      'List the top 5 San Francisco news from the past week.' +
      'You must include the date of each article.',
  });

  // access the grounding metadata. Casting to the provider metadata type
  // is optional but provides autocomplete and type safety.
  const metadata = providerMetadata?.google as
    | GoogleGenerativeAIProviderMetadata
    | undefined;
  const groundingMetadata = metadata?.groundingMetadata;
  const safetyRatings = metadata?.safetyRatings;

  console.log('Generated text:', text);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
