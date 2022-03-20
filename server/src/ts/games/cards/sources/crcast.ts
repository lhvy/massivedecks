import * as Source from "../source";
import genericPool from "generic-pool";
import http, { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";
import * as Config from "../../../config";
import HttpStatus from "http-status-codes";
import {
  SourceNotFoundError,
  SourceServiceError,
} from "../../../errors/action-execution-error";
import * as Decks from "../decks";
import JSON5 from "json5";
import * as Card from "../card";

export interface CrCast {
  source: "CrCast";
  deckCode: string;
}

export interface ClientInfo {
  baseUrl: string;
}

export class Resolver extends Source.Resolver<CrCast> {
  public readonly source: CrCast;
  private readonly config: Config.CrCast;
  private readonly connectionPool: genericPool.Pool<AxiosInstance>;

  public constructor(
    source: CrCast,
    config: Config.CrCast,
    connectionPool: genericPool.Pool<AxiosInstance>
  ) {
    super();
    this.source = source;
    this.config = config;
    this.connectionPool = connectionPool;
  }

  public id(): string {
    return "CrCast";
  }

  public deckId(): string {
    return this.source.deckCode;
  }

  public loadingDetails(): Source.Details {
    return {
      name: `CrCast ${this.source.deckCode}`,
    };
  }

  public equals(source: Source.External): boolean {
    return (
      source.source === "CrCast" && this.source.deckCode === source.deckCode
    );
  }

  public async getTag(): Promise<string | undefined> {
    return (await this.summary()).tag;
  }

  public async atLeastSummary(): Promise<Source.AtLeastSummary> {
    return await this.summaryAndTemplates();
  }

  public async atLeastTemplates(): Promise<Source.AtLeastTemplates> {
    return await this.summaryAndTemplates();
  }

  public summaryAndTemplates = async (): Promise<{
    summary: Source.Summary;
    templates: Decks.Templates;
  }> => {
    const connection = await this.connectionPool.acquire();
    try {
      const rawInfo = (await connection.get(`cc/decks/${this.source.deckCode}`))
        .data;
      const rawCards = (
        await connection.get(`cc/decks/${this.source.deckCode}/cards`)
      ).data;
      const info = typeof rawInfo === "string" ? JSON5.parse(rawInfo) : rawInfo;
      const cards =
        typeof rawCards === "string" ? JSON5.parse(rawCards) : rawCards;
      const summary = {
        details: {
          name: info.name,
          url: `${this.config.baseUrl}decks/${this.source.deckCode}`,
        },
        calls: cards.calls.length,
        responses: cards.responses.length,
      };
      return {
        summary: summary,
        templates: {
          calls: new Set(cards.calls.map(this.call)),
          responses: new Set(cards.responses.map(this.response)),
        },
      };
    } catch (e) {
      if (Object.prototype.hasOwnProperty.call(e, "response")) {
        const error = e as AxiosError;
        const response = error.response;
        if (response?.status === HttpStatus.NOT_FOUND) {
          throw new SourceNotFoundError(this.source);
        } else {
          throw new SourceServiceError(this.source);
        }
      } else {
        throw e;
      }
    } finally {
      await this.connectionPool.release(connection);
    }
  };

  private call = (call: { text: string[] }): Card.Call => {
    var part: Card.Part[] = [];
    // A slot should be added in between each item in the text array.
    for (let i = 0; i < call.text.length; i++) {
      part.push(call.text[i].trim());
      part.push(" ", {});
    }
    part.pop(); // Remove extra whitespace.
    part.pop(); // Remove extra slot.
    return {
      id: Card.id(),
      parts: [part], // No new line support in CrCast.
      source: this.source,
    };
  };

  private response = (response: { text: string[] }): Card.Response => ({
    id: Card.id(),
    text: response.text[0],
    source: this.source,
  });
}

export class MetaResolver implements Source.MetaResolver<CrCast> {
  private readonly connectionPool: genericPool.Pool<AxiosInstance>;
  private readonly config: Config.CrCast;
  public readonly cache = true;

  public constructor(config: Config.CrCast) {
    this.config = config;

    const httpConfig: AxiosRequestConfig = {
      method: "GET",
      baseURL: config.baseUrl,
      timeout: config.timeout,
      responseType: "json",
    };

    this.connectionPool = genericPool.createPool(
      {
        create: async () => http.create(httpConfig),
        destroy: async (_) => {
          // Do nothing.
        },
      },
      { max: config.simultaneousConnections }
    );
  }

  public clientInfo(): ClientInfo {
    return {
      baseUrl: this.config.baseUrl,
    };
  }

  limitedResolver(source: CrCast): Resolver {
    return this.resolver(source);
  }

  resolver(source: CrCast): Resolver {
    return new Resolver(source, this.config, this.connectionPool);
  }
}

export const load = async (config: Config.CrCast): Promise<MetaResolver> =>
  new MetaResolver(config);
