import {
	// These are same as http1 for the usage here
	constants as h2constants,
} from "http2";

import { pipeline } from "stream";

import {
	constants as zlibConstants,
	createBrotliDecompress,
	createGunzip,
	createInflate,
	ZlibOptions,
} from "zlib";

const {
	HTTP2_HEADER_LOCATION,
	HTTP2_HEADER_STATUS,
	HTTP2_HEADER_CONTENT_TYPE,
	HTTP2_HEADER_CONTENT_ENCODING,
	HTTP2_HEADER_CONTENT_LENGTH,
} = h2constants;

import {
	BodyTypes,
	DecodeFunction,
	Decoder,
	HttpVersion,
	ResponseInit,
	ResponseTypes,
} from "./core";

import {
	AbortSignal,
} from "./abort";

import {
	hasBuiltinBrotli,
} from "./utils";

import {
	ensureHeaders,
	GuardedHeaders,
	Headers,
} from "./headers";

import {
	Body,
} from "./body";

import {
	IncomingHttpHeaders,
} from "./types";


interface Extra
{
	httpVersion: HttpVersion;
	redirected: boolean;
	integrity: string;
	signal: AbortSignal;
	type: ResponseTypes;
	url: string;
}

export class Response extends Body
{
	// @ts-ignore
	public readonly headers: Headers;
	// @ts-ignore
	public readonly ok: boolean;
	// @ts-ignore
	public readonly redirected: boolean;
	// @ts-ignore
	public readonly status: number;
	// @ts-ignore
	public readonly statusText: string;
	// @ts-ignore
	public readonly type: ResponseTypes;
	// @ts-ignore
	public readonly url: string;
	// @ts-ignore
	public readonly useFinalURL: boolean;
	// @ts-ignore
	public readonly httpVersion: HttpVersion;

	constructor(
		body: BodyTypes | Body | null = null,
		init: Partial< ResponseInit > = { },
		extra?: Partial< Extra >
	)
	{
		super( );

		const headers = ensureHeaders(
			init.allowForbiddenHeaders
			? new GuardedHeaders( "none", init.headers )
			: init.headers
		);

		const _extra = < Partial< Extra > >( extra || { } );

		const type = _extra.type || "basic";
		const redirected = !!_extra.redirected || false;
		const url = _extra.url || "";
		const integrity = _extra.integrity || null;

		this.setSignal( _extra.signal );

		if ( body )
		{
			const contentType = headers.get( HTTP2_HEADER_CONTENT_TYPE );
			const contentLength = headers.get( HTTP2_HEADER_CONTENT_LENGTH );
			const contentEncoding =
				headers.get( HTTP2_HEADER_CONTENT_ENCODING );

			const length =
				( contentLength == null || contentEncoding != null )
				? null
				: parseInt( contentLength, 10 );

			if ( contentType )
				this.setBody( body, contentType, integrity, length );
			else
				this.setBody( body, null, integrity, length );
		}

		Object.defineProperties( this, {
			headers: {
				enumerable: true,
				value: headers,
			},
			httpVersion: {
				enumerable: true,
				value: _extra.httpVersion,
			},
			ok: {
				enumerable: true,
				get: ( ) => this.status >= 200 && this.status < 300,
			},
			redirected: {
				enumerable: true,
				value: redirected,
			},
			status: {
				enumerable: true,
				value: init.status || 200,
			},
			statusText: {
				enumerable: true,
				value: init.statusText || "",
			},
			type: {
				enumerable: true,
				value: type,
			},
			url: {
				enumerable: true,
				value: url,
			},
			useFinalURL: {
				enumerable: true,
				value: undefined,
			},
		} );
	}

	// Returns a new Response object associated with a network error.
	public static error( ): Response
	{
		const headers = new GuardedHeaders( "immutable" );
		const status = 521;
		const statusText = "Web Server Is Down";
		return new Response(
			null, { headers, status, statusText }, { type: "error" } );
	}

	// Creates a new response with a different URL.
	public static redirect( url: string, status?: number )
	{
		status = status || 302;

		const headers = {
			[ HTTP2_HEADER_LOCATION ]: url,
		};

		return new Response( null, { headers, status } );
	}

	// Creates a clone of a Response object.
	public clone( ): Response
	{
		const { headers, status, statusText } = this;
		return new Response( this, { headers, status, statusText } );
	}
}

function makeHeadersFromH2Headers(
	headers: IncomingHttpHeaders,
	allowForbiddenHeaders: boolean
)
: Headers
{
	const out = new GuardedHeaders(
		allowForbiddenHeaders ? "none" : "response" );

	for ( const key of Object.keys( headers ) )
	{
		if ( key.startsWith( ":" ) )
			// We ignore pseudo-headers
			continue;

		const value = headers[ key ];
		if ( Array.isArray( value ) )
			value.forEach( val => out.append( key, val ) );
		else if ( value != null )
			out.set( key, value );
	}

	return out;
}

function makeInitHttp1(
	inHeaders: IncomingHttpHeaders,
	allowForbiddenHeaders: boolean
)
: Partial< ResponseInit >
{
	// Headers in HTTP/2 are compatible with HTTP/1 (colon illegal in HTTP/1)
	const headers =
		makeHeadersFromH2Headers( inHeaders, allowForbiddenHeaders );

	return { headers };
}

function makeInitHttp2(
	inHeaders: IncomingHttpHeaders,
	allowForbiddenHeaders: boolean
)
: Partial< ResponseInit >
{
	const status = parseInt( "" + inHeaders[ HTTP2_HEADER_STATUS ], 10 );
	const statusText = ""; // Not supported in H2
	const headers =
		makeHeadersFromH2Headers( inHeaders, allowForbiddenHeaders );

	return { status, statusText, headers };
}

function makeExtra(
	httpVersion: HttpVersion,
	url: string,
	redirected: boolean,
	signal?: AbortSignal,
	integrity?: string
)
: Partial< Extra >
{
	const type = "basic"; // TODO: Implement CORS

	return { httpVersion, redirected, integrity, signal, type, url };
}

function handleEncoding(
	contentDecoders: ReadonlyArray< Decoder >,
	stream: NodeJS.ReadableStream,
	headers: IncomingHttpHeaders
)
: NodeJS.ReadableStream
{
	const contentEncoding = headers[ HTTP2_HEADER_CONTENT_ENCODING ] as string;

	if ( !contentEncoding )
		return stream;

	const handleStreamResult = ( _err: NodeJS.ErrnoException | null ) =>
	{
		// TODO: Add error handling
	};

	const zlibOpts: ZlibOptions = {
		flush: zlibConstants.Z_SYNC_FLUSH,
		finishFlush: zlibConstants.Z_SYNC_FLUSH,
	};

	const decoders: { [ name: string ]: DecodeFunction; } = {
		deflate: ( stream: NodeJS.ReadableStream ) =>
			pipeline( stream, createInflate( ), handleStreamResult ),
		gzip: ( stream: NodeJS.ReadableStream ) =>
			pipeline( stream, createGunzip( zlibOpts ), handleStreamResult ),
	};

	if ( hasBuiltinBrotli( ) )
	{
		decoders.br = ( stream: NodeJS.ReadableStream ) =>
			pipeline( stream, createBrotliDecompress( ), handleStreamResult );
	}

	contentDecoders.forEach( decoder =>
	{
		decoders[ decoder.name ] = decoder.decode;
	} );

	const decoder = decoders[ contentEncoding ];

	if ( !decoder )
		// We haven't asked for this encoding, and we can't handle it.
		// Pushing raw encoded stream through...
		return stream;

	return decoder( stream );
}

export class StreamResponse extends Response
{
	constructor(
		contentDecoders: ReadonlyArray< Decoder >,
		url: string,
		stream: NodeJS.ReadableStream,
		headers: IncomingHttpHeaders,
		redirected: boolean,
		init: Partial< ResponseInit >,
		signal: AbortSignal | undefined,
		httpVersion: HttpVersion,
		allowForbiddenHeaders: boolean,
		integrity?: string
	)
	{
		super(
			handleEncoding(
				contentDecoders,
				< NodeJS.ReadableStream >stream,
				headers
			),
			{
				...init,
				allowForbiddenHeaders,
				...(
					httpVersion === 1
					? makeInitHttp1( headers, allowForbiddenHeaders )
					: makeInitHttp2( headers, allowForbiddenHeaders )
				),
			},
			makeExtra( httpVersion, url, redirected, signal, integrity )
		);
	}
}
